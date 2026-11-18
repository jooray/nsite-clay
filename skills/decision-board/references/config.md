# Settings

    node <skill>/scripts/config.mjs [board.json]

prints the settings that apply, which files were read, and any key a project file tried to set
and was not allowed to. Values of `ownerNpub` and `notify.command` print as `(set)`.

## Where they come from

Earlier wins, key by key:

1. `DECISION_BOARD_CONFIG`, a path. If set, it is the only file read, and it counts as the
   user's file.
2. `decision-board.config.json` next to board.json, then in each parent folder up to the
   repository root. **A project file may set only `language`, `expires` and `watch`.**
3. The user's file: `$XDG_CONFIG_HOME/decision-board/config.json`, by default
   `~/.config/decision-board/config.json`; on Windows `%APPDATA%\decision-board\config.json`.
4. Built-in defaults.

Environment variables count as the user: `DECISION_BOARD_ARTIFACT_TOOL` (a path) and
`DECISION_BOARD_NOTIFY_COMMAND` (a program name, or a JSON array).

Why a project file is limited: it arrives with somebody else's repository. If it could set a
command, opening that repository would run their program on your machine. If it could set the
owner or the writing check, it could add a stranger to your page or steer your agent.

## Keys

| key | default | |
|---|---|---|
| `language` | `"en"` | page language when board.json has no `lang`; `sk` uses `locales/sk.json` |
| `timeZone` | `null` | for times the agent writes in text; the page itself uses the reader's zone |
| `expires` | `"30d"` | page expiry at publish |
| `access` | `"link"` | `link`: anyone with the edit link can open and answer. `members`: no key in any link, only the owner's npub opens it |
| `ownerNpub` | `null` | the owner's Nostr public key. User file only |
| `watch.ask` | `true` | ask the owner how long to watch |
| `watch.default` | `"24h"` | the recommended answer |
| `watch.choices` | `["4h","24h","7d","until-decided"]` | what to offer |
| `watch.everySeconds` | `600` | check interval |
| `watch.settleSeconds` | `45` | wait for the owner to stop ticking |
| `notify.command` | `null` | program that sends the owner a message; the text arrives on stdin. A string is split on spaces, or give an argv array. No shell. User file only |
| `notify.includeEditLink` | `true` | append the page's full edit link to every message |
| `artifactTool` | `null` | path to `artifact.mjs` when nsite-artifacts is not next to this skill. User file only |
| `workspace` | `null` | publish new boards as pages of this nsite-artifacts workspace (`true` for its default one), passed on as `--workspace`. Pages published before keep their own site. User file only |
| `writingCheck` | `null` | one sentence or a skill name the agent applies to page text before building. User file only |
| `confirmInChat` | `["delete","deploy","publish","spend","send"]` | instructions from the page box that need a confirmation first. User file only |

## The owner and the link

With `access: "link"` (the default) the page is opened by its edit link. Every notification
carries that link whole, so the owner never has to sign in.

With `ownerNpub` set as well, the owner's key is also added as a member of the page: `publish`
passes `--member=<npub>` to `artifact create`, and `push` runs `artifact share <id>
--member=<npub>` once for a page published before the npub was set. If the owner loses the
link, they open the page's address and sign in with their own key, for example with a remote
signer app. Without `ownerNpub` nothing changes.

`access: "members"` makes a page with no key in any link at all. The owner must sign in every
time. Use it when the link may travel through a channel you do not trust.

## Example user file

```json
{
  "language": "en",
  "timeZone": "Europe/Vienna",
  "ownerNpub": "npub1...",
  "watch": { "default": "24h" },
  "notify": { "command": ["my-send-message", "--to", "me"], "includeEditLink": true },
  "writingCheck": "Short sentences, no filler, no em dashes."
}
```

With nothing configured: English, link access, 30 days, ask for the watch window with 24 hours
recommended, and no notification. The agent tells the owner in the chat.
