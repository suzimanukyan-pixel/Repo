/**
 * Sync Slack usergroup membership from Airtable.
 *
 * Hubs table:
 *  - "Group ID" = Slack usergroup id (S0A...)
 *  - "Coordinators" = linked records to Coordinators table (array of record ids)
 *
 * Coordinators table:
 *  - Slack ID field contains either "U...." or "<@U....>"
 */

const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;

const HUBS_TABLE = process.env.AIRTABLE_HUBS_TABLE || "Hubs";
const COORDINATORS_TABLE = process.env.AIRTABLE_COORDINATORS_TABLE || "Coordinators";

const HUBS_GROUP_ID_FIELD = process.env.AIRTABLE_HUBS_GROUP_ID_FIELD || "Group ID";
const HUBS_COORDINATORS_LINK_FIELD =
  process.env.AIRTABLE_HUBS_COORDINATORS_LINK_FIELD || "Coordinators";

const COORDINATORS_SLACK_ID_FIELD =
  process.env.AIRTABLE_COORDINATORS_SLACK_ID_FIELD || "Slack ID"; // <-- set your secret to "Slack ID" too

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

function normalizeSlackId(value) {
  // Airtable may return string OR array (lookup/formula). Normalize.
  let raw = value;
  if (Array.isArray(raw)) raw = raw[0];
  if (typeof raw !== "string") return null;

  // Accept either "Uxxxx" or "<@Uxxxx>"
  const cleaned = raw.replace(/^<@/, "").replace(/>$/, "").trim();

  // Slack user IDs typically start with U or W
  if (!/^[UW][A-Z0-9]{2,}$/.test(cleaned)) return null;
  return cleaned;
}

(async function main() {
  if (!AIRTABLE_BASE_ID || !AIRTABLE_TOKEN || !SLACK_BOT_TOKEN) {
    throw new Error("Missing required env vars: AIRTABLE_BASE_ID, AIRTABLE_TOKEN, SLACK_BOT_TOKEN");
  }

  console.log("Loading Coordinators table...");
  const coordinators = await airtableList(COORDINATORS_TABLE);

  // Map: coordinator recordId -> Slack user id (U... or W...)
  const slackIdByCoordinatorRecordId = {};
  for (const c of coordinators) {
    const slackId = normalizeSlackId(c.fields?.[COORDINATORS_SLACK_ID_FIELD]);
    if (slackId) slackIdByCoordinatorRecordId[c.id] = slackId;
  }

  console.log(`Loaded ${Object.keys(slackIdByCoordinatorRecordId).length} coordinator Slack IDs.`);

  console.log("Loading Hubs table...");
  const hubs = await airtableList(HUBS_TABLE);

  for (const h of hubs) {
    const groupId = h.fields?.[HUBS_GROUP_ID_FIELD];
    if (!groupId) {
      console.log(`Skipping hub ${h.id}: missing "${HUBS_GROUP_ID_FIELD}"`);
      continue;
    }

    const linkedCoordinatorRecordIds = h.fields?.[HUBS_COORDINATORS_LINK_FIELD] || [];
    const slackUserIds = uniq(
      linkedCoordinatorRecordIds.map((rid) => slackIdByCoordinatorRecordId[rid]).filter(Boolean)
    );

    console.log(
      `Updating Slack usergroup ${groupId} with ${slackUserIds.length} users: ${slackUserIds.join(", ")}`
    );

    // IMPORTANT: Slack errors if users list is empty. Skip instead of failing the whole run.
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
      // Don't fail the entire job because one group had an issue
      console.error(`Failed updating usergroup ${groupId}:`, err);
      continue;
    }
  }

  console.log("✅ Sync complete");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
