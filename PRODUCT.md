# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Two groups reach the publisher, and the flow branches for them at sign-in rather
than later:

- **People who already hold a Nostr key.** They have Amber or a browser
  extension and usually a Lightning wallet. They can be spoken to in ordinary
  Nostr vocabulary and want the shortest path.
- **People who arrive with nothing.** No key, no sats, often from a link
  somebody shared. The flow has to make them a key, explain that the key *is*
  the ownership, and walk them through a first payment without using the words
  manifest, relay, blob or Blossom.

Both are publishing one page for themselves or a small thing they run: a
bakery, an event, a portfolio, a links page. They are not running a web
project and will not open a terminal.

## Product Purpose

Publish a single HTML page that afterwards edits and republishes itself. The
page is the product: open it, sign in with the key that owns it, type into it,
press Save. Success is somebody who publishes once through the wizard and never
needs the wizard again.

## Positioning

The document is the application. There is no server, no account and no
database: relays hold a signed manifest, Blossom holds the bytes, and the page
checks a signature to decide who may write to it. The key is the only
credential and the only proof of ownership. Everything is MIT-0 and the same
publish can be done from a terminal with `npx nsite-clay deploy`, so nothing in
the hosted wizard is a lock-in.

## Operating Context

- The publisher is itself a published nsite, reached through a gateway. Gateways
  are slow and erratic, so the flow must survive multi-second waits.
- Signing happens in Amber over NIP-46, in a browser extension, or from a pasted
  nsec. A bunker round trip takes seconds and prompts on a phone.
- Money is Cashu ecash and Lightning. The default AI provider is our own Routstr
  node; an owner may point at another node or bring an OpenAI-compatible key.
- Four languages ship together, English, Spanish, Slovak, Czech, from one
  strings table. Any user-visible string exists in all four or the build fails.

## Capabilities and Constraints

- The wizard's four steps are sign in, choose a starting point, choose a path,
  publish. AI page creation is a route inside the second step.
- **AI creation is paid before it runs.** No free generation: Simple setup is
  the gate, and the sequence is key first, then payment, then generation.
- **Simple setup is 2000 sats**, split visibly: 1000 to the donation sink as
  support for the project, 1000 as the buyer's own AI credit. The credit is
  theirs and withdrawable at any time.
- Measured cost of the default model: 17 to 22 sats for a generated page, well
  under a sat for editing a paragraph. So 1000 sats is roughly 45 pages or
  hundreds of edits.
- The AI key must be recoverable without a downloaded file: stored on the user's
  own relays, encrypted to their own key.
- Advanced use, another node or an OpenAI-compatible key of their own, stays
  available but must not sit in the first-run path.
- A published page keeps the runtime URLs it was published with. Upgrades reach
  it only when its owner accepts one.
- No em or en dashes in any shipped prose, in any language.

## Brand Commitments

- Name: nsite-clay. Voice is plain, concrete and unhurried; it explains what a
  thing is rather than selling it.
- The free paths stay real and visible: twelve templates, and the CLI. Paid AI
  is convenience, never the only way in.
- `site/llms.txt` currently promises "no account, no password reset, no billing
  relationship". Paid AI does not create an account, but the sentence needs
  revisiting so it stays true once money changes hands.

## Evidence on Hand

- Two real paid runs on the default model: 43.5s / 21.8 sats and 27.6s / 17.4
  sats for a complete page.
- Live rates read from the node at audit time: 0.439 / 1.756 sats per 1000
  tokens, input / output.
- Gateway behaviour measured on nsite.lol: first byte 0.8 to 3.1 seconds,
  throughput 15 to 73 KB/s across three consecutive attempts.

## Open Decisions

- Whether the donation half is ever presented as optional. Confirmed for now as
  a fixed, visible half of one price, not a checkbox.
- Whether nsite-clay runs its own gateway. No public alternative measured faster
  than nsite.lol; gittr was worse and no other npub-subdomain gateway exists.
