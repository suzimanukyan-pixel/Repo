name: Sync Slack Usergroups from Airtable

on:
  workflow_dispatch: {}
  schedule:
    - cron: "0 14 * * *"

jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: "20"

      - name: Run sync
        env:
          AIRTABLE_BASE_ID: ${{ secrets.AIRTABLE_BASE_ID }}
          AIRTABLE_TOKEN: ${{ secrets.AIRTABLE_TOKEN }}
          SLACK_BOT_TOKEN: ${{ secrets.SLACK_BOT_TOKEN }}

          AIRTABLE_HUBS_TABLE: ${{ secrets.AIRTABLE_HUBS_TABLE }}
          AIRTABLE_COORDINATORS_TABLE: ${{ secrets.AIRTABLE_COORDINATORS_TABLE }}

          AIRTABLE_HUBS_GROUP_ID_FIELD: ${{ secrets.AIRTABLE_HUBS_GROUP_ID_FIELD }}
          AIRTABLE_HUBS_COORDINATORS_LINK_FIELD: ${{ secrets.AIRTABLE_HUBS_COORDINATORS_LINK_FIELD }}
          AIRTABLE_COORDINATORS_SLACK_ID_FIELD: ${{ secrets.AIRTABLE_COORDINATORS_SLACK_ID_FIELD }}
        run: node sync.js
