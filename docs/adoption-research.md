# Hyperclay adoption and Routstr

Research verified on 2026-09-22. The full working note lives at
`01 Projects/Nostr creator tools/nsite-clay/hyperclay-research.md` in the project vault.

## Existing dependencies

nsite-clay implements its own editor and CMS. It does not bundle an old ClayJS,
RichClay or HyperCMS release. DOMPurify is the shared dependency: the lockfile
has 3.4.14 and npm has 3.4.15. Adopt individual libraries without replacing the
document's `nc:cms` contract.

First steps, each tested and committed separately: update DOMPurify; add
quickcrop; add document-wide undo; extend CMS field types and its data API;
adapt ClayJS's verified source-preserving serializer. Only then add AI.

## AI decisions

- Default node: `https://routstr.cypherpunk.today`.
- Default model: `deepseek-v4-1-flash`, confirmed in the node's model list.
- Let the owner choose a model, another Routstr node, or an OpenAI-compatible
  BYOK endpoint in settings. Never silently fail over to another operator.
- Keep credentials tied to their endpoint and out of the document and prompts.
- Extend the publisher: start from a template or describe a page from scratch,
  preview it, then publish through the existing signer and Blossom flow.
- On existing pages, edit a selected element with a preview and an undoable
  acceptance. Generation alone never publishes anything.

The live node's OpenAPI schema and CORS preflight support a browser client:

| Task | Endpoint |
|---|---|
| Models and rates | `GET /v1/models` |
| Inference | `POST /v1/chat/completions` |
| Cashu deposit | `POST /v1/balance/create` with `initial_balance_token` |
| Balance | `GET /v1/balance/info` |
| Cashu top-up | `POST /v1/balance/topup` with `cashu_token` |
| Lightning invoice | `POST /v2/lightning/invoice` with `amount_sats`, `purpose` |
| Invoice status | `GET /v2/lightning/invoice/{invoice_id}/status` |
| Invoice recovery | `POST /v2/lightning/recover` with `bolt11` |
| Refund | `POST /v1/balance/refund` |

Inference, balance, top-up and refund use a Bearer API key. A new paid Lightning
invoice or Cashu deposit returns that key. Use POST bodies for Cashu tokens.
NIP-98 is unnecessary for prepaid inference; Nostr signatures still own publishing.
Use local API fixtures for payment tests. Live payment verification needs funded
test credit and has not been performed during research.

## Corrections to the first research note

Inline text editing and the browser's text undo already exist. The missing parts
are inline CMS fields and a history covering structural edits. Source ranges are
UTF-16 string offsets, not byte offsets. Source-preserving saves keep formatting
but still upload a whole Blossom blob. MIT-0 requires no attribution; bundled
third-party licenses have their own requirements. BYOK requires browser CORS
support and does not imply support for every provider's API dialect.

## Sources

- https://github.com/panphora/clayjs at `7b50315e8f732e92643ab2e953648994cb37a442`
- https://github.com/panphora/quickcrop
- https://github.com/panphora/hyper-undo
- https://docs.routstr.com/client/payments/
- https://docs.routstr.com/client/integration/
- https://routstr.cypherpunk.today/openapi.json
- https://routstr.cypherpunk.today/v1/info
- https://routstr.cypherpunk.today/v1/models
