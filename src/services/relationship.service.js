import { isSentinelValue } from "./overrides.service";
/**
 * Harmonizes static, permanent physical and draft biographical properties across multiple plays
 * of the same player. If values are empty, it propagates the non-empty values from another play.
 * If conflicting non-empty values are found (like two different birthplaces), it stores the
 * merged set for visual display; the conflict itself is reported on the Corrections page.
 * 
 * Target Fields: DraftYear, DraftRound, DraftSelection, DraftTeam, Birthdate, Birthplace.
 */
// Keyed on the plays array identity (getAllPlaysDB returns a stable array
// until a write): four pages call this on navigation, and each call used
// to re-clone ~9,000 play objects.
const harmonizedCache = new WeakMap();

export function harmonizePlayerProfiles(plays) {
  if (!plays || plays.length === 0) return plays;
  if (harmonizedCache.has(plays)) return harmonizedCache.get(plays);

  // Work on shallow clones: the input usually comes straight from the shared
  // getAllPlaysDB() RAM cache, and mutating those objects leaked harmonized
  // values into every other page reading the same cache.
  const clonedPlays = plays.map((play) => ({ ...play }));

  const playersMap = {};

  // Group fields by player
  clonedPlays.forEach((play) => {
    const name = play.FullName;
    if (!name) return;

    if (!playersMap[name]) {
      playersMap[name] = {
        name,
        plays: [],
        fields: {
          DraftYear: {},
          DraftRound: {},
          DraftSelection: {},
          DraftTeam: {},
          Birthdate: {},
          Birthplace: {}
        }
      };
    }

    playersMap[name].plays.push(play);

    // Collect non-empty values and record their matching playIDs
    const targetFields = ["DraftYear", "DraftRound", "DraftSelection", "DraftTeam", "Birthdate", "Birthplace"];
    targetFields.forEach((field) => {
      const val = play[field];
      if (val && val !== "0" && !isSentinelValue(val) && String(val).trim() !== "") {
        const cleanVal = String(val).trim();
        const freqMap = playersMap[name].fields[field];
        if (!freqMap[cleanVal]) {
          freqMap[cleanVal] = [];
        }
        freqMap[cleanVal].push(play.playID);
      }
    });
  });

  // Harmonize fields
  Object.values(playersMap).forEach((playerObj) => {
    const { plays: playerPlays, fields } = playerObj;

    Object.entries(fields).forEach(([field, valFreqMap]) => {
      const uniqueVals = Object.keys(valFreqMap);

      if (uniqueVals.length === 1) {
        // EXACTLY one non-empty value exists: propagate it to all empty fields for this player's plays!
        const valueToFill = uniqueVals[0];
        playerPlays.forEach((play) => {
          const currentVal = play[field];
          if (!currentVal || currentVal === "0" || isSentinelValue(currentVal) || String(currentVal).trim() === "") {
            play[field] = valueToFill;
          }
        });
      } else if (uniqueVals.length > 1) {
        // CONFLICT. These surface on the Corrections page (Open Findings tab) via
        // detectProfileConflicts in audit.service.js, with suggested override
        // JSON blocks ready to copy.
        // Save the merged conflicting string on a special property for visual references
        const joinedVal = uniqueVals.join(" / ");
        playerPlays.forEach((play) => {
          play[`${field}_merged`] = joinedVal;
        });
      }
    });
  });

  harmonizedCache.set(plays, clonedPlays);
  return clonedPlays;
}

