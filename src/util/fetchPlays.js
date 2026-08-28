import * as fcl from "@onflow/fcl"

// 3000 exceeds the execution nodes' computation limit now that there are 9000+ plays
const limit = 1000

const playsScript = () => fcl.script`
    import TopShot from 0x${window.topshotAddress}
access(all) struct MyPlay {
  access(all) let playID: UInt32
  access(all) let metadata: {String:String}

  init(playID: UInt32, metadata: {String:String}) {
    self.playID = playID
    self.metadata = metadata
  }
}
access(all) struct TopShotData {
  access(all) let totalSupply: UInt64
  access(all) let plays: [MyPlay]
  access(all) let currentSeries: UInt32
  access(all) var lastPlayFetched: Bool
  access(all) let nextPlayID: UInt32
  init() {
    self.totalSupply = TopShot.totalSupply
    self.currentSeries = TopShot.currentSeries
    self.plays = []
    self.lastPlayFetched= false
    self.nextPlayID = TopShot.nextPlayID
  }
  access(all) fun addPlay(p: MyPlay) {
    self.plays.append(p)
    if TopShot.nextPlayID-1 == p.playID {
      self.lastPlayFetched = true
    }
  }
}
access(all) fun main(start: UInt32, end: UInt32): TopShotData {
  let ts = TopShotData()
  var i = start
  while i < end {
    let pm = TopShot.getPlayMetaData(playID: i)
    if pm == nil {
      break
    }
    ts.addPlay(p: MyPlay(playID: i, metadata: pm!))
  i = i + 1
  }
  return ts
}`

const fetchBatch = async (start, end) => {
    // the access node reports rate limiting inside an HTTP 200, so retry on
    // any error rather than trusting the transport
    let lastErr = null
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            const resp = await fcl.send([
                playsScript(),
                fcl.args([fcl.arg(start, fcl.t.UInt32), fcl.arg(end, fcl.t.UInt32)]),
            ])
            return await fcl.decode(resp)
        } catch (err) {
            lastErr = err
            console.error(`plays batch ${start}-${end} attempt ${attempt + 1} failed:`, err)
            await new Promise((r) => setTimeout(r, 500 * (attempt + 1)))
        }
    }
    throw lastErr
}

// run tasks with at most `size` in flight; full parallelism trips the
// access node's rate limiting
const pool = async (tasks, size) => {
    const results = new Array(tasks.length)
    let next = 0
    const workers = Array.from({length: Math.min(size, tasks.length)}, async () => {
        while (next < tasks.length) {
            const i = next++
            results[i] = await tasks[i]()
        }
    })
    await Promise.all(workers)
    return results
}

// plays only ever grow, so one fetch per page load is plenty; the Reload
// button passes force=true to bypass this
let cachedPlays = null

const getTopShotPlays = async (force = false, onProgress = () => {}) => {
    if (cachedPlays && !force) return cachedPlays

    // the first batch tells us nextPlayID, then the rest fetch a few at a time
    const first = await fetchBatch(1, 1 + limit)
    const total = Number(first.nextPlayID) - 1
    let loaded = first.plays.length
    onProgress(loaded, total)
    let res = first
    if (!first.lastPlayFetched) {
        const starts = []
        for (let s = 1 + limit; s < Number(first.nextPlayID); s += limit) {
            starts.push(s)
        }
        const rest = await pool(starts.map((s) => async () => {
            const batch = await fetchBatch(s, s + limit)
            loaded += batch.plays.length
            onProgress(loaded, total)
            return batch
        }), 3)
        for (const batch of rest) {
            res = {
                ...res,
                ...batch,
                plays: [...res.plays, ...batch.plays],
            }
        }
    }
    cachedPlays = res
    return res
}

export {getTopShotPlays};
