import React, {useState, useEffect} from "react"
import styled from "styled-components"
import {MirroredDatatable} from "../util/MirroredDatatable"
import {getTopShotPlays} from "../util/fetchPlays";

const Root = styled.div`
  font-size: 13px;
  padding: 21px;
`

const Muted = styled.span`
  color: #78899a;
`

const H1 = styled.h1``

const config = {
  page_size: 100,
  length_menu: [ 100 ], // the table adds an "All" option itself
  no_data_text: 'No data available!',
  sort: { column: "playID", order: "desc" },
  key_column: "playID"
}

export function TopshotPlays() {
  const [error, setError] = useState(null)

  // used to chek the reload, so another reload is not triggered while the previous is still running
  // const [done, setDone] = useState(false)

  const [topshotPlays, setTopshotPlays] = useState(null)
  const [progress, setProgress] = useState(null)
  useEffect(() => {
    document.title = "Plays | Topshot Explorer"
  }, [])
  useEffect(() => {
    load()
      .catch(() => setError(true))
  }, [])

  // for reloading
    // disable auto refresh for now
  // useEffect(() => {
  //   if(done){
  //     // set some delay
  //     const timer = setTimeout(()=>{
  //       load()
  //       .catch((e)=>{
  //         setDone(true) // enable reloading again for failed reload attempts
  //       })
  //     }, 5000)
  //     return () => clearTimeout(timer);
  //   }
  // }, [done]);

  const load = (force) => {
    // setDone(false)
    return getTopShotPlays(force, (loaded, total) => setProgress({loaded, total}))
      .then((d) => {
        console.log(d)
        setTopshotPlays(d)
        // setDone(true)
      })
  }

  if (error != null)
    return (
      <Root>
        <Root>
          <H1>
            <Muted>TopShot: </Muted>
            <span>0x0b2a3299cc857e29</span>
          </H1>
          <h3>
            <span>Error Fetching TopShot Info: {error}</span>
          </h3>
        </Root>
      </Root>
    )
  if (topshotPlays == null) {
    const pct = progress ? Math.round((progress.loaded / progress.total) * 100) : 0
    return (
      <Root>
        <h3>
          <span>
            {progress
              ? `Fetching Plays: ${progress.loaded.toLocaleString()} of ${progress.total.toLocaleString()}`
              : "Fetching Plays..."}
          </span>
        </h3>
        <div className="progress" style={{maxWidth: "480px", height: "14px"}}>
          <div
            className="progress-bar progress-bar-striped progress-bar-animated"
            role="progressbar"
            style={{width: `${Math.max(pct, 4)}%`}}
            aria-valuenow={pct}
            aria-valuemin="0"
            aria-valuemax="100"
          />
        </div>
      </Root>
    )
  }

  var columns_found = { 'playID': true }; // add playID to columns found since it's in metadata
  topshotPlays.plays.forEach(play => { // get all possible column keys (names) in metadata
    for (var key in play.metadata) {
      columns_found[key] = true;
    }
  });
  columns_found = Object.keys(columns_found); // convert object to array, save only keys

  // preferred column order
  const columns_order = [
    'playID',
    'FullName',
    'DateOfMomentLocal',
    'PlayType',
    'PlayCategory',
    'TeamAtMoment',
    'TeamAtMomentNBAID',
    'HomeTeamName', // game details
    'HomeTeamScore',
    'AwayTeamName',
    'AwayTeamScore',
    'Outcome',
    'NbaSeason',
    'TotalYearsExperience',
    'PrimaryPosition', // play (info specific to play or point in time)
    'PlayerPosition',
    'JerseyNumber',
    'DraftYear',
    'DraftRound',
    'DraftSelection',
    'DraftTeam',
    'Birthdate',
    'Birthplace',
    'Height',
    'Weight',
    'CurrentTeam', // optional and infrequent
    'CurrentTeamID',
  ];

  const columns_extra = columns_found.filter(value => !columns_order.includes(value));
  var columns_ordered = columns_order.concat(columns_extra); // append additional columns not initially found in columns_order

  var columns_exclude = ['LastName', 'FirstName', 'DateOfMoment', 'Tagline']; // columns to exclude
  columns_ordered = columns_ordered.filter(value => !columns_exclude.includes(value));

  console.log(columns_ordered);

  var columns = [];
  columns_ordered.forEach(column_key => {
    columns.push({
      key: column_key,
      text: column_key,
      align: "left",
      sortable: true
    });
  });

  var data = [];
  topshotPlays.plays.forEach(play => {
    var metadata = play.metadata;
    for (let key in metadata) {
      if (metadata[key] === '<invalid Value>' || metadata[key] === 'N/A') { // remove invalid on-chain values OR set N/A to empty for format consistency
        metadata[key] = '';
      }
    }

    const fix_keys = ['HomeTeamScore', 'AwayTeamScore', 'DraftYear', 'Weight'] // fix the associated value if equal to 0
    fix_keys.forEach(key => {
      if (parseInt(metadata[key]) === 0) {
        metadata[key] = '';
      }
    });

    if (metadata.Birthplace) { // fix inconsistent formatting of Birthplace
      metadata.Birthplace = metadata.Birthplace.split(',').map(item => item.trim()).filter(item => item).join(', ');
    }

    metadata.playID = play.playID;

    let date_options = {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    };

    if (metadata.DateOfMoment) {
      metadata.DateOfMomentLocal = new Date(metadata.DateOfMoment).toLocaleString(undefined, date_options);
    }

    metadata.Outcome = (metadata.HomeTeamName === metadata.TeamAtMoment)
    ? (parseInt(metadata.HomeTeamScore) > parseInt(metadata.AwayTeamScore) ? 'Home Win' : 'Home Loss')
    : (parseInt(metadata.HomeTeamScore) > parseInt(metadata.AwayTeamScore) ? 'Away Loss' : 'Away Win');

    data.push(metadata);
  });

  return (
    <Root>
      <H1>
        <span>Plays</span>
      </H1>
      <div>
        {topshotPlays && (
          <div>
            <MirroredDatatable
              config={config}
              records={data}
              columns={columns}
              extraButtons={[]}
            />
          </div>
        )}
      </div>
    </Root>
  )
}
