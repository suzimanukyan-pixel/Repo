/**
 * Sync Slack usergroup membership from Airtable.
 *
 * Hubs table:
 *  - "Group ID" = Slack usergroup id (S0A...)
 *  - "Coordinators" = linked records to Coordinators table (array of record ids)
 *
 * Coordinators table:
 *  - Slack ID field contains either "U...." or "<@U....>" (can be string or array via lookup/formula)
 */

const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;

const HUBS_TABLE = process.env.AIRTABLE_HUBS_TABLE || "Hubs";
const COORDINATORS_TABLE = process.env.AIRTABLE_COORDINATORS_TABLE || "Coordinators";

const HUBS_GROUP_ID_FIELD = process.env.AIRTABLE_HUBS_GROUP_ID_FIELD || "Group ID";
const HUBS_COORDINATORS_LINK_FIELD =
  process.env.AIRTABLE_HUBS_COORDINATORS_LINK_FIELD || "Coordinators";

const COORDINATORS_SLACK_ID_FIELD =
  process.env.AIRTABLE_COORDINATORS_SLACK_ID_FIELD || "Slack ID";

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;

async function airtableList(tableName) {
  const records = [];
  let offset;

  while (true) {
    const url = new URL(
      `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(tableName)}`
    );
    url.searchParams.set("pageSize", "100");
    if (offset) url.searchParams.set("offset", offset);

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` },
    });

    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`Airtable list failed (${res.status}): ${txt}`);
    }

    const data = await res.json();
    records.push(...(data.records || []));
    if (!data.offset) break;
    offset = data.offset;
  }

  return records;
}

async function slackCall(method, body) {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(body),
  });

  const data = await res.json();
  if (!data.ok) {
    throw new Error(
      `Slack API ${method} failed: ${data.error || "unknown_error"} | ${JSON.stringify(data)}`
    );
  }
  return data;
}

function uniq(arr) {
  return [...new Set(arr.filter(Boolean))];
}

/**
 * Extract a Slack user id (U... or W...) from:
 *  - "U07A50Y0LC8"
 *  - "<@U07A50Y0LC8>"
 *  - ["<@U07A50Y0LC8>"] (lookup/formula arrays)
 *  - any string containing a Slack id
 */
function normalizeSlackId(value) {
  if (value == null) return null;

  // Convert arrays to a single searchable string
  const raw = Array.isArray(value) ? value.join(" ") : String(value);

  // Find a Slack user id anywhere in the string
  const match = raw.match(/([UW][A-Z0-9]{2,})/);
  if (!match) return null;

  return match[1];
}

(async function main() {
  if (!AIRTABLE_BASE_ID || !AIRTABLE_TOKEN || !SLACK_BOT_TOKEN) {
    throw new Error("Missing required env vars: AIRTABLE_BASE_ID, AIRTABLE_TOKEN, SLACK_BOT_TOKEN");
  }

  console.log(`Loading Coordinators table: ${COORDINATORS_TABLE}`);
  const coordinators = await airtableList(COORDINATORS_TABLE);
console.log(
  "Coordinator fields available (first record):",
  Object.keys(coordinators?.[0]?.fields || {})
);
console.log("Using COORDINATORS_SLACK_ID_FIELD =", COORDINATORS_SLACK_ID_FIELD);
console.log(
  "Sample value for that field =",
  coordinators?.[0]?.fields?.[COORDINATORS_SLACK_ID_FIELD]
);

// Map: coordinator recordId -> Slack user id
const slackIdByCoordinatorRecordId = {};
// Map: coordinator NAME (lowercased) -> Slack user id
const slackIdByCoordinatorName = {};

let invalidSlackIdCount = 0;

for (const c of coordinators) {
  const rawValue = c.fields?.[COORDINATORS_SLACK_ID_FIELD];
  const slackId = normalizeSlackId(rawValue);

  if (!slackId) {
    invalidSlackIdCount += 1;
    continue;
  }

  slackIdByCoordinatorRecordId[c.id] = slackId;

  const name = (c.fields?.Name || "").toString().trim().toLowerCase();
  if (name) slackIdByCoordinatorName[name] = slackId;
}

      // Helpful for debugging (does not print secrets)
      // Comment this out later if too noisy:
      // console.log(`Coordinator ${c.id} missing/invalid Slack ID in field "${COORDINATORS_SLACK_ID_FIELD}"`);
    }
  }

  console.log(
    `Loaded ${Object.keys(slackIdByCoordinatorRecordId).length} coordinator Slack IDs. Invalid/missing: ${invalidSlackIdCount}`
  );

  console.log(`Loading Hubs table: ${HUBS_TABLE}`);
  const hubs = await airtableList(HUBS_TABLE);

  for (const h of hubs) {
    const groupId = h.fields?.[HUBS_GROUP_ID_FIELD];
    if (!groupId) {
      console.log(`Skipping hub ${h.id}: missing "${HUBS_GROUP_ID_FIELD}"`);
      continue;
    }

    const hubCoordinatorsRaw = h.fields?.[HUBS_COORDINATORS_LINK_FIELD] || [];

const slackUserIds = uniq(
  (Array.isArray(hubCoordinatorsRaw) ? hubCoordinatorsRaw : [hubCoordinatorsRaw])
    .map((item) => {
      // Case A: linked record IDs: "recXXXX"
      if (typeof item === "string" && item.startsWith("rec")) {
        return slackIdByCoordinatorRecordId[item];
      }

      // Case B: lookup values: "Suzi", "Anna", etc.
      if (typeof item === "string") {
        return slackIdByCoordinatorName[item.trim().toLowerCase()];
      }

      // Fallback: unknown type
      return null;
    })
    .filter(Boolean)
);


    console.log(
      `Updating Slack usergroup ${groupId} with ${slackUserIds.length} users: ${slackUserIds.join(", ")}`
    );

    // Slack errors if users list is empty. Skip instead of failing the whole run.
    if (slackUserIds.length === 0) {
      console.log(`Skipping ${groupId}: no valid Slack user IDs found (would error in Slack).`);
      continue;
    }

    try {
      await slackCall("usergroups.users.update", {
        usergroup: groupId,
        users: slackUserIds.join(","),
      });
    } catch (err) {
      console.error(`Failed updating usergroup ${groupId}:`, err);
      continue;
    }
  }

  console.log("✅ Sync complete");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
