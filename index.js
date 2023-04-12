const b4a = require('b4a')
const ReadyResource = require('ready-resource')
const FIFO = require('fast-fifo')
const debounceify = require('debounceify')
const c = require('compact-encoding')
const safetyCatch = require('safety-catch')

const Linearizer = require('./lib/linearizer')
const LinearizedCore = require('./lib/core')
const SystemView = require('./lib/system')
const messages = require('./lib/messages')

const inspect = Symbol.for('nodejs.util.inspect.custom')

class Writer {
  constructor (base, core, length) {
    this.base = base
    this.core = core
    this.nodes = []
    this.length = length
    this.offset = length
    this.indexed = length

    this.next = null
    this.nextCache = null
  }

  compare (writer) {
    return b4a.compare(this.core.key, writer.core.key)
  }

  head () {
    const len = this.length - this.offset
    return len === 0 ? null : this.nodes[len - 1]
  }

  shift () {
    if (this.offset === this.length) return null
    this.offset++
    return this.nodes.shift()
  }

  getCached (seq) {
    return seq >= this.offset ? this.nodes[seq - this.offset] : null
  }

  reset (length) {
    this.length = length || 0

    this.next = null
    this.nextCache = null

    // TODO: handle offset/shifts
    this.nodes = this.nodes.slice(0, length)
  }

  advance (node = this.next) {
    this.nodes.push(node)
    this.next = null
    this.nextCache = null
    this.length++
    return node
  }

  append (value, dependencies, batch) {
    const node = Linearizer.createNode(this, this.length + 1, value, [], batch, dependencies)

    for (const dep of dependencies) {
      if (dep.clock !== null) {
        for (const [writer, length] of dep.clock) {
          if (node.clock.get(writer) < length) {
            node.clock.set(writer, length)
          }
        }
      }

      node.heads.push({
        key: dep.writer.core.key,
        length: dep.length
      })
    }

    node.clock.set(node.writer, node.length)

    this.advance(node)
    return node
  }

  async ensureNext () {
    if (this.length >= this.core.length || this.core.length === 0) return null
    if (this.next !== null || !(await this.core.has(this.length))) return this.next

    if (this.nextCache === null) {
      const block = await this.core.get(this.length)
      const value = c.decode(this.base.valueEncoding, block.value)
      this.nextCache = Linearizer.createNode(this, this.length + 1, value, block.heads, block.batch, [])
    }

    this.next = await this.ensureNode(this.nextCache)
    return this.next
  }

  async ensureNode (node) {
    while (node.dependencies.length < node.heads.length) {
      const rawHead = node.heads[node.dependencies.length]

      const headWriter = await this.base._getWriterByKey(rawHead.key)
      if (headWriter === null || headWriter.length < rawHead.length) {
        return null
      }

      const headNode = headWriter.getCached(rawHead.length - 1)

      if (headNode === null) { // already yielded
        popAndSwap(node.heads, node.dependencies.length)
        continue
      }

      node.dependencies.push(headNode)

      await this._addClock(node.clock, headNode)
    }

    node.clock.set(node.writer, node.length)

    return node
  }

  async getCheckpoint () {
    await this.core.update()

    let length = this.core.length
    if (length === 0) return null

    let node = await this.core.get(length - 1)
    if (node.checkpointer !== 0) {
      length -= node.checkpointer
      node = await this.core.get(length - 1)
    }

    return node.checkpoint
  }

  async _addClock (clock, node) {
    if (node.clock === null) return // gc'ed
    for (const [writer, length] of node.clock) {
      if (clock.get(writer) < length && !(await this.base.system.isIndexed(writer.core.key, length))) {
        clock.set(writer, length)
      }
    }
  }
}

class LinearizedStore {
  constructor (base) {
    this.base = base
    this.opened = new Map()
    this.waiting = []
  }

  get (opts, moreOpts) {
    if (typeof opts === 'string') opts = { name: opts }
    if (moreOpts) opts = { ...opts, ...moreOpts }

    const name = opts.name
    const valueEncoding = opts.valueEncoding

    if (this.opened.has(name)) return this.opened.get(name).openSession(opts)

    const core = this.base.store.get({ name: 'view/' + name })
    const l = new LinearizedCore(this.base, core, name, valueEncoding)

    this.waiting.push(l)
    this.opened.set(name, l)

    return l.openSession(opts)
  }

  async update () {
    while (this.waiting.length) {
      const core = this.waiting.pop()
      await core.ready()
    }
  }
}

module.exports = class Autobase extends ReadyResource {
  constructor (store, bootstraps, handlers) {
    super()

    this.sparse = false
    this.bootstraps = [].concat(bootstraps || []).map(toKey).sort((a, b) => b4a.compare(a, b))
    this.valueEncoding = c.from(handlers.valueEncoding || 'binary')
    this.store = store
    this._primaryBootstrap = null

    if (this.bootstraps.length) {
      this._primaryBootstrap = this.store.get(this.bootstraps[0])
      this.store = this.store.namespace(this._primaryBootstrap)
    }

    this.local = Autobase.getLocalCore(this.store)
    this.localWriter = null
    this.linearizer = null

    this.writers = []
    this.system = new SystemView(this, this.store.get({ name: 'system' }))

    this._appending = new FIFO()
    this._appendingBatchLength = 0

    this._applying = null
    this._needsReady = []
    this._removedWriters = []
    this._updates = []
    this._handlers = handlers || {}

    this._bump = debounceify(this._advance.bind(this))
    this._onremotewriterchange = () => this._bump().catch(safetyCatch)

    this._checkpointer = 0
    this._checkpoint = null

    this._hasApply = !!this._handlers.apply
    this._hasOpen = !!this._handlers.open

    this._viewStore = new LinearizedStore(this)

    this.view = this._hasOpen ? this._handlers.open(this._viewStore, this) : null

    this.ready().catch(safetyCatch)
  }

  [inspect] (depth, opts) {
    let indent = ''
    if (typeof opts.indentationLvl === 'number') {
      while (indent.length < opts.indentationLvl) indent += ' '
    }

    return indent + 'Autobase { ... }'
  }

  get writable () {
    return this.localWriter !== null
  }

  async _open () {
    await this.store.ready()
    await this.local.ready()
    await this.system.ready()

    if (this.system.bootstrapping && this.bootstraps.length === 0) {
      this.bootstraps.push(this.local.key) // new autobase!
    }

    await this._restart()
    await this._bump()
  }

  async _close () {
    await this.store.close()
  }

  async update (opts) {
    if (!this.opened) await this.ready()

    for (const w of this.writers) {
      await w.core.update(opts)
      if (!this.sparse) await downloadAll(w.core)
    }

    await this._bump()
  }

  ack () {
    return this.append(null)
  }

  async append (value) {
    if (!this.opened) await this.ready()

    if (this.localWriter === null) {
      throw new Error('Not writable')
    }

    if (Array.isArray(value)) {
      for (const v of value) this._appending.push(v)
      this._appendingBatchLength += value.length
    } else {
      this._appending.push(value)
      this._appendingBatchLength++
    }

    await this._bump()
  }

  async checkpoint () {
    await this.ready()
    const all = []

    for (const w of this.writers) {
      all.push(w.getCheckpoint())
    }

    const checkpoints = await Promise.all(all)
    let best = null

    for (const c of checkpoints) {
      if (!c) continue
      if (best === null || c.length > best.length) best = c
    }

    return best
  }

  static getLocalCore (store) {
    return store.get({ name: 'local', valueEncoding: messages.OplogMessage })
  }

  _getWriterByKey (key) {
    for (const w of this.writers) {
      if (b4a.equals(w.core.key, key)) return w
    }

    return null
  }

  _ensureAll () {
    const p = []
    for (const w of this.writers) {
      if (w.next === null) p.push(w.ensureNext())
    }
    return Promise.all(p)
  }

  _makeWriter (key, length) {
    const local = b4a.equals(key, this.local.key)

    for (let i = 0; i < this._removedWriters.length; i++) {
      const w = this._removedWriters[i]

      if (b4a.equals(w.core.key, key)) {
        w.reset(length)

        popAndSwap(this._removedWriters, i)
        if (local) this.localWriter = w

        return w
      }
    }

    if (!length) length = 0

    const core = local
      ? this.local.session({ valueEncoding: messages.OplogMessage })
      : this.store.get({ key, sparse: this.sparse, valueEncoding: messages.OplogMessage })

    // Small hack for now, should be fixed in hypercore (that key is set immediatly)
    core.key = key
    this._needsReady.push(core)

    const w = new Writer(this, core, length)

    if (local) {
      this.localWriter = w
    } else {
      core.on('append', this._onremotewriterchange)
    }

    return w
  }

  async _restart () {
    for (const w of this.writers) this._removedWriters.push(w)

    this.localWriter = null

    const indexers = []

    const writers = this.system.bootstrapping
      ? this.bootstraps.map(key => ({ key, length: 0 }))
      : this.system.digest.writers

    for (const { key, length } of writers) {
      indexers.push(this._makeWriter(key, length))
    }

    const heads = []

    for (const head of this.system.digest.heads) {
      for (const w of indexers) {
        if (b4a.equals(w.core.key, head.key)) {
          heads.push(Linearizer.createNode(w, head.length, null, [], 1, []))
        }
      }
    }

    this.writers = indexers.slice(0)
    this.linearizer = new Linearizer(indexers, heads)

    // TODO: this is a bit silly (hitting it with the biggest of hammers)
    // but an easy fix for now so cores are "up to date"
    this._undo(this._updates.length)

    await this._cleanup()
  }

  async _advance () {
    while (true) {
      // localWriter may have been unset by a restart
      if (this.localWriter) {
        let batch = this._appendingBatchLength
        this._appendingBatchLength = 0

        while (batch) {
          const value = this._appending.shift()
          const heads = this.linearizer.heads.slice(0)
          const node = this.localWriter.append(value, heads, batch--)
          this.linearizer.addHead(node)
        }
      }

      let active = true

      while (active) {
        await this._ensureAll()

        active = false
        for (const w of this.writers) {
          if (!w.next) continue
          this.linearizer.addHead(w.advance())
          active = true
          break
        }
      }

      const u = this.linearizer.update()
      const needsRestart = u ? await this._applyUpdate(u) : false

      if (this.localWriter !== null && this.localWriter.length > this.local.length) {
        await this._flushLocal()
      }

      if (needsRestart === false) break
      await this._restart()
    }

    await this._cleanup()
  }

  async _cleanup () {
    while (this._needsReady.length > 0) {
      await this._needsReady.pop().ready()
    }

    while (this._removedWriters.length > 0) {
      const w = this._removedWriters.pop()
      await w.core.close()

      if (w === this.localWriter) {
        this.localWriter = null
      }
    }
  }

  // triggered from linearized core
  _onuserappend (core, blocks) {
    if (this._applying === null) throw new Error('Append is only allowed in apply')

    if (core.appending === 0) {
      this._applying.user.push({ core, appending: 0 })
    }

    core.appending += blocks
  }

  _onsystemappend (blocks) {
    if (this._applying === null) throw new Error('System changes are only allowed in apply')

    this._applying.system += blocks
  }

  // triggered from system
  _onaddwriter (key) {
    for (const w of this.writers) {
      if (b4a.equals(w.core.key, key)) return
    }

    this.writers.push(this._makeWriter(key))
  }

  // triggered from system
  _onremovewriter (key) {
    for (let i = 0; i < this.writers.length; i++) {
      const w = this.writers[i]

      if (b4a.equals(w.core.key, key)) {
        popAndSwap(this.writers, i)
        this._removedWriters.push(w)
        return
      }
    }
  }

  _undo (popped) {
    const truncating = []
    let systemPop = 0

    while (popped > 0) {
      const u = this._updates.pop()

      popped -= u.batch
      systemPop += u.system

      for (const { core, appending } of u.user) {
        if (core.truncating === 0) truncating.push(core)
        core.truncating += appending
      }
    }

    if (systemPop > 0) {
      this.system._onundo(systemPop)
    }

    for (const core of truncating) {
      const truncating = core.truncating
      core.truncating = 0
      core._onundo(truncating)
    }
  }

  _bootstrap () {
    for (const key of this.bootstraps) {
      this.system.addWriter(key)
    }
  }

  async _applyUpdate (u) {
    await this._viewStore.update()

    if (u.popped) this._undo(u.popped)

    let batch = []
    let j = 0

    for (let i = 0; i < Math.min(u.indexed.length, u.shared); i++) {
      const node = u.indexed[i]

      node.writer.indexed++
      if (node.batch > 1) continue

      const update = this._updates[j++]
      if (update.system === 0) continue

      await this._flushAndCheckpoint(i + 1, node.indexed)
      return true
    }

    for (let i = u.shared; i < u.length; i++) {
      const indexed = i < u.indexed.length
      const node = indexed ? u.indexed[i] : u.tip[i - u.indexed.length]

      if (indexed) {
        node.writer.indexed++
      }

      batch.push({
        indexed,
        from: node.writer.core,
        length: node.length,
        value: node.value,
        heads: node.heads
      })

      if (node.batch > 1) continue

      const update = { batch: batch.length, system: 0, user: [] }

      this._updates.push(update)
      this._applying = update
      if (this.system.bootstrapping) this._bootstrap()
      if (this._hasApply === true) await this._handlers.apply(batch, this.view, this)
      this._applying = null

      batch = []

      for (let i = 0; i < update.user.length; i++) {
        const u = update.user[i]
        u.appending = u.core.appending
        u.core.appending = 0
      }

      if (update.system > 0 && indexed) {
        await this._flushAndCheckpoint(i + 1, node.indexed)
        return true
      }
    }

    if (u.indexed.length) {
      await this._flushAndCheckpoint(u.indexed.length, u.indexed[u.indexed.length - 1].indexed)
    }

    return false
  }

  async _flushAndCheckpoint (indexed, heads) {
    const checkpoint = await this._flushIndexes(indexed, heads)

    if (checkpoint === null) return

    this._checkpoint = checkpoint
    this._checkpointer = 0
  }

  async _flushIndexes (indexed, heads) {
    const updatedCores = []
    let updatedSystem = 0

    while (indexed > 0) {
      const u = this._updates.shift()
      const user = []

      indexed -= u.batch
      updatedSystem += u.system

      for (const { core, appending } of u.user) {
        const start = core.indexing
        const blocks = core.tip.slice(start, core.indexing += appending)
        if (start === 0) updatedCores.push(core)

        await core.core.append(blocks)

        const tree = core.core.core.tree

        user.push({
          name: core.name,
          treeHash: tree.hash(),
          length: tree.length
        })
      }

      await this.system.flush(u.system, user, this.writers, heads)
    }

    for (const core of updatedCores) {
      const indexing = core.indexing
      core.indexing = 0
      core._onindex(indexing)
    }

    if (updatedSystem) {
      this.system._onindex(updatedSystem)
    }

    return this.system.checkpoint()
  }

  _flushLocal () {
    const blocks = new Array(this.localWriter.length - this.local.length)

    for (let i = 0; i < blocks.length; i++) {
      const { value, heads, batch } = this.localWriter.getCached(this.local.length + i)

      blocks[i] = {
        value: c.encode(this.valueEncoding, value),
        heads,
        batch,
        checkpointer: this._checkpointer,
        checkpoint: this._checkpointer === 0 ? this._checkpoint : null
      }

      if (this._checkpointer > 0 || this._checkpoint !== null) {
        this._checkpointer++
        this._checkpoint = null
      }
    }

    return this.local.append(blocks)
  }
}

function toKey (k) {
  return b4a.isBuffer(k) ? k : b4a.from(k, 'hex')
}

function popAndSwap (list, i) {
  const pop = list.pop()
  if (i >= list.length) return false
  list[i] = pop
  return true
}

function downloadAll (core) {
  const start = core.length
  const end = core.core.tree.length

  return core.download({ start, end, ifAvailable: true }).done()
}
