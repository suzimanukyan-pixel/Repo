/**
 * Sync Slack usergroup membership from Airtable.
 *
 * Hubs table:
 *  - "Group ID" = Slack usergroup id (S0A...)
 *  - "Coordinators" can be:
 *      - linked record IDs (["rec...","rec..."])
 *      - lookup/rollup names (["Suzi","Anna"])
 *      - single string "Suzi, Anna" or "Suzi\nAnna"
 *      - objects (rare) depending on field type
 *
 * Coordinators table:
 *  - "Slack ID" contains either "U...." or "<@U....>" (string or array)
 *  - "Name" is the coordinator name
 */

const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;

const HUBS_TABLE = process.env.AIRTABLE_HUBS_TABLE || "Hubs";
const COORDINATORS_TABLE = process.env.AIRTABLE_COORDINATORS_TABLE || "Coordinators";

const HUBS_GROUP_ID_FIELD = process.env.AIRTABLE_HUBS_GROUP_ID_FIELD || "Group ID";
const HUBS_COORDINATORS_FIELD =
  process.env.AIRTABLE_HUBS_COORDINATORS_LINK_FIELD || "Coordinators";

// Hardcode these to avoid whitespace/secret mismatch
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

function normalizeSlackId(value) {
  if (value == null) return null;
  const raw = Array.isArray(value) ? value.join(" ") : String(value);
  const match = raw.match(/([UW][A-Z0-9]{2,})/);
  return match ? match[1] : null;
}

function normalizeName(value) {
  if (value == null) return null;
  return String(value).trim().toLowerCase();
}

/**
 * Turn the Hubs "Coordinators" field into a flat list of tokens.
 * A token can be:
 *   - "recXXXX" (Airtable record id)
 *   - "Suzi" (name)
 */
function explodeHubCoordinators(raw) {
  const tokens = [];

  const pushString = (s) => {
    if (!s) return;
    // split on commas, semicolons, pipes, and newlines
    const parts = String(s)
      .split(/[,;\|\n]+/g)
      .map((p) => p.trim())
      .filter(Boolean);
    tokens.push(...parts);
  };

  const handleItem = (item) => {
    if (item == null) return;

    // Most common: string ("rec..." or "Suzi" or "Suzi, Anna")
    if (typeof item === "string") {
      pushString(item);
      return;
    }

    // Some Airtable field types can return objects
    if (typeof item === "object") {
      // if object has an id that looks like rec...
      if (typeof item.id === "string" && item.id.startsWith("rec")) {
        tokens.push(item.id);
        return;
      }
      // if object has a name-like field
      if (typeof item.name === "string") {
        pushString(item.name);
        return;
      }
      // try common keys if present
      for (const key of ["Name", "name", "value", "label"]) {
        if (typeof item[key] === "string") {
          pushString(item[key]);
          return;
        }
      }
      return;
    }

    // fallback
    pushString(String(item));
  };

  if (raw == null) return tokens;

  if (Array.isArray(raw)) {
    for (const item of raw) handleItem(item);
    return tokens;
  }

  handleItem(raw);
  return tokens;
}

(async function main() {
  if (!AIRTABLE_BASE_ID || !AIRTABLE_TOKEN || !SLACK_BOT_TOKEN) {
    throw new Error("Missing required env vars: AIRTABLE_BASE_ID, AIRTABLE_TOKEN, SLACK_BOT_TOKEN");
  }

  console.log(`Loading Coordinators table: ${COORDINATORS_TABLE}`);
  const coordinators = await airtableList(COORDINATORS_TABLE);

  // Build lookups
  const slackIdByCoordinatorRecordId = {};
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
console.log("Hubs fields available (first record):", Object.keys(hubs?.[0]?.fields || {}));
console.log("Using HUBS_COORDINATORS_FIELD =", HUBS_COORDINATORS_FIELD);
console.log("Using HUBS_GROUP_ID_FIELD =", HUBS_GROUP_ID_FIELD);

  for (const h of hubs) {
    const groupId = h.fields?.[HUBS_GROUP_ID_FIELD];
    if (!groupId) {
      console.log(`Skipping hub ${h.id}: missing "${HUBS_GROUP_ID_FIELD}"`);
      continue;
    }

    const raw = h.fields?.[HUBS_COORDINATORS_FIELD];

    // DEBUG (safe): shows what Airtable is actually sending for the coordinators field
    // Comment out once everything works.
    console.log(
      `Hub "${h.fields?.Name || h.id}" coordinators raw:`,
      JSON.stringify(raw)
    );

    const tokens = explodeHubCoordinators(raw);

    const slackUserIds = uniq(
      tokens
        .map((t) => {
          if (!t) return null;
          if (t.startsWith("rec")) return slackIdByCoordinatorRecordId[t];
          return slackIdByCoordinatorName[normalizeName(t)];
        })
        .filter(Boolean)
    );

    console.log(
      `Updating Slack usergroup ${groupId} with ${slackUserIds.length} users: ${slackUserIds.join(", ")}`
    );

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
      console.error(`Failed updating usergroup ${groupId}:`, err?.message || err);
      continue;
    }
  }

  console.log("✅ Sync complete");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
