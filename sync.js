/**
 * Sync Slack usergroup membership from Airtable.
 *
 * Hubs table:
 *  - "Group ID" = Slack usergroup id (S0A...)
 *  - "Coordinators" = linked records OR lookup names from Coordinators table
 *
 * Coordinators table:
 *  - "Slack ID" contains either "U...." or "<@U....>" (string or array)
 *  - "Name" is coordinator name
 */

const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;

const HUBS_TABLE = process.env.AIRTABLE_HUBS_TABLE || "Hubs";
const COORDINATORS_TABLE = process.env.AIRTABLE_COORDINATORS_TABLE || "Coordinators";

const HUBS_GROUP_ID_FIELD = process.env.AIRTABLE_HUBS_GROUP_ID_FIELD || "Group ID";
const HUBS_COORDINATORS_LINK_FIELD =
  process.env.AIRTABLE_HUBS_COORDINATORS_LINK_FIELD || "Coordinators";

// Hardcode to avoid secret/whitespace mismatch
const COORDINATORS_SLACK_ID_FIELD = "Slack ID";
const COORDINATORS_NAME_FIELD = "Name";

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

// Extract Slack user ID from "<@UXXXX>" or "UXXXX" or arrays/strings containing it
function normalizeSlackId(value) {
  if (value == null) return null;

  const raw = Array.isArray(value) ? value.join(" ") : String(value);
  const match = raw.match(/([UW][A-Z0-9]{2,})/);
  if (!match) return null;

  return match[1];
}

function normalizeName(value) {
  if (value == null) return null;
  return String(value).trim().toLowerCase();
}

(async function main() {
  if (!AIRTABLE_BASE_ID || !AIRTABLE_TOKEN || !SLACK_BOT_TOKEN) {
    throw new Error("Missing required env vars: AIRTABLE_BASE_ID, AIRTABLE_TOKEN, SLACK_BOT_TOKEN");
  }

  console.log(`Loading Coordinators table: ${COORDINATORS_TABLE}`);
  const coordinators = await airtableList(COORDINATORS_TABLE);

  // Map by Airtable record id (rec...)
  const slackIdByCoordinatorRecordId = {};
  // Map by Coordinator name (lowercased)
  const slackIdByCoordinatorName = {};

  let invalidSlackIdCount = 0;

  for (const c of coordinators) {
    const slackId = normalizeSlackId(c.fields?.[COORDINATORS_SLACK_ID_FIELD]);
    if (!slackId) {
      invalidSlackIdCount += 1;
      continue;
    }

    slackIdByCoordinatorRecordId[c.id] = slackId;

    const name = normalizeName(c.fields?.[COORDINATORS_NAME_FIELD]);
    if (name) slackIdByCoordinatorName[name] = slackId;
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

    const raw = h.fields?.[HUBS_COORDINATORS_LINK_FIELD] || [];
    const items = Array.isArray(raw) ? raw : [raw];

    const slackUserIds = uniq(
      items
        .map((item) => {
          if (typeof item !== "string") return null;

          // Case A: linked record IDs
          if (item.startsWith("rec")) return slackIdByCoordinatorRecordId[item];

          // Case B: lookup values are names
          return slackIdByCoordinatorName[normalizeName(item)];
        })
        .filter(Boolean)
    );

    console.log(
      `Updating Slack usergroup ${groupId} with ${slackUserIds.length} users: ${slackUserIds.join(", ")}`
    );

    // Slack errors if list is empty — keep existing members
    if (slackUserIds.length === 0) {
      console.log(`Skipping ${groupId}: no valid Slack user IDs found (would error in Slack).`);
      continue;
    }

    // This replaces the group membership
    await slackCall("usergroups.users.update", {
      usergroup: groupId,
      users: slackUserIds.join(","),
    });
  }

  console.log("✅ Sync complete");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
