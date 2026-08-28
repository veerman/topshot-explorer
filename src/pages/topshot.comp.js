import React, {useState, useEffect} from "react"
import * as fcl from "@onflow/fcl"
import styled from "styled-components"

// the homepage only shows the headline numbers; fetching plays or sets
// here would pull megabytes of data it never renders
const getTopShotOverview = async () => {
    const resp = await fcl.send([
        fcl.script`
    import TopShot from 0x${window.topshotAddress}
    access(all) struct Overview {
      access(all) let totalSupply: UInt64
      access(all) let currentSeries: UInt32
      init() {
        self.totalSupply = TopShot.totalSupply
        self.currentSeries = TopShot.currentSeries
      }
    }
    access(all) fun main(): Overview {
      return Overview()
    } `,
    ])
    return fcl.decode(resp)
}

const Root = styled.div`
  // font-family: monospace;
  // color: #233445;
  font-size: 13px;
  padding: 21px;
`

const Muted = styled.span`
  color: #78899a;
`

export function TopShot() {
  const [error, setError] = useState(null)
  const [topshotData, setTopShotData] = useState(null)
  useEffect(() => {
    document.title = "Topshot Explorer"
  }, [])
  useEffect(() => {
    getTopShotOverview()
      .then((d) => {
        setTopShotData(d)
      })
      .catch((e) => setError(JSON.stringify(e)))
  }, [])

  if (error != null)
    return (
      <Root>
        <Root>
          <h3>
            <span>Error Fetching TopShot Info: {error}</span>
          </h3>
        </Root>
      </Root>
    )
  if (topshotData == null)
    return (
      <Root>
        <h3>
          <span>Fetching info for TopShot</span>
        </h3>
      </Root>
    )

  return (
    <Root>
      <h3>
        <Muted>TopShot Contract: </Muted>
        <span>0x0b2a3299cc857e29</span>
      </h3>
      <h3>
        <Muted>TopShot Market Contract: </Muted>
        <span>0xc1e4f4f4c4257510</span>
      </h3>
      <div>
        {topshotData && (
          <div>
            <h3>
              <Muted>Total Supply: </Muted>
              <span>{topshotData.totalSupply}</span>
            </h3>
            <h3>
              <Muted>Current Series: </Muted>
              <span>S{topshotData.currentSeries}</span>
            </h3>
          </div>
        )}
      </div>

      <p>
        Built with{" "}
        <span role="img" aria-labelledby="heart">
          ❤️
        </span>{" "}
        on <a href="https://www.onflow.org/" target="_blank" rel="noopener noreferrer">flow</a>
        <br/>
        open sourced <a href="https://github.com/rrrkren/topshot-explorer" target="_blank" rel="noopener noreferrer">here</a>, PRs welcome!
      </p>
    </Root>
  )
}
