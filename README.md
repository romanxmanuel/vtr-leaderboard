# VTR Live Leaderboard

TV-style sales leaderboard for the office. Dark green/gold theme, auto-refreshes every 30 seconds.

## What it shows

- Agent Leaderboard (top 10 by AP)
- Team Standings
- Premium Per Policy
- Recent Sales feed (live ticker)
- Time filters: Today / Week / Month / YTD

## Setup

### 1. Google Sheet

Create a Google Sheet with these tabs:

**Sales Feed** (columns):
- Agent, Team, Carrier, Policy Type, Photo URL, AP, Sale Date, Timestamp, Policy #

**Agents** (columns):
- Agent Name, Team, Photo URL

**Call Feed** (optional, columns):
- Agent Name, Dials, Inbound, Outbound, Hours

Make the sheet link-readable (Share → Anyone with the link can view).

### 2. Configure

Set the environment variable `LEADERBOARD_SHEET_ID` to your sheet's ID (the long string in the sheet URL).

### 3. Eterna webhook

In the Eterna CRM portal (portal.goeterna.com):

1. Go to Automations, create a new workflow
2. Add triggers: Submitted, In Underwriting, Approved
3. Add a POST action to your Zapier webhook URL
4. Map the fields: agent name, AP, carrier, policy type, sale date, policy number
5. Activate the workflow

### 4. Zapier

Create a Zap:
- Trigger: Webhooks by Zapier (Catch Hook)
- Action: Google Sheets (Create Spreadsheet Row) → your Sales Feed tab
- Map the webhook fields to the sheet columns

### 5. Run

```bash
bun install
bun run build
bun run start
```

Open on a laptop, connect to TV via HDMI, set to duplicate/extend display.

## Design notes

- No close rate or dialing stats (no call data tracked)
- No placeholder text; empty states are honest
- Product type shows on every sale; blank stays blank (never use "Life Insurance" as a generic type)
- Tapping a sale replays its celebration animation
