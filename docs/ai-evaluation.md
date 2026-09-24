# Evaluating real AI output

The automated application tests use fixed replies. They prove that payment,
preview, undo and publishing work, but do not prove that a model builds a useful
page. This corpus tests that separately.

## Cases

`test/ai-evaluation/cases.json` contains eight ready-to-use prompts:

| Case | What it tests |
| --- | --- |
| cafe-en | Prices, opening hours, an exceptional evening event and photo spaces |
| cafe-sk | Natural Slovak, accents, euro prices and closed days |
| event-es | Spanish, a prominent date, location and a clear free-entry action |
| portfolio-cs | Czech, artwork/caption association and a useful contact action |
| photo-preservation | Exact image IDs and URLs through a redesign |
| iterative-page | Facts and added requirements surviving two refinements |
| long-guide | Twelve complete sections, useful contents links and mobile layout |
| unsupported-backend | An honest static result instead of fake booking/payment controls |

The names, businesses, addresses and contact details are fictional test data.
The photo case starts from `test/ai-evaluation/photos.html`. The runner serves
two deliberately distinct image fixtures so their identities can be checked.

## Run

List cases without making any provider requests:

```sh
node tools/ai-evaluate.mjs --list
```

Build the current runtime, then run one case with a provider key supplied through
the environment. A run spends that key's AI credit. `iterative-page` makes three
requests; every other case makes one. Nothing is published.

```sh
npm run build
# Set NSITE_AI_KEY using your usual secret-management method.
node tools/ai-evaluate.mjs --live --case=cafe-en --model=deepseek-v4-1-flash
```

Optional arguments: `--base=https://your-node.example/v1`, `--mode=byok`,
`--out=/path/to/results`. The default output is a newly named temporary directory.
The key is not written to the result files. The runner uses the installed Chrome
and the same client, prompts, sanitisation and page preparation as the product.

Each run writes HTML, 1440px and 390px screenshots, latency, editable-field count,
image identities, unresolved fragment links, missing required terms and a scoring
record. It also records the observed Routstr balance difference when available.
That difference is not an authoritative invoice: reservations may settle later,
and other requests using the same key can affect it. BYOK cost is marked
unavailable; copy actual usage/cost from the provider when reviewing.

## Score each result

Use 0 for broken, 1 for substantial correction needed, 2 for usable with minor
correction, and 3 for ready to use. Fill the five `humanScores` in `results.json`:

- **Design:** deliberate hierarchy, readable contrast, consistent spacing and
  typography. Do not award points merely for having a stylesheet.
- **Facts:** all supplied facts survive, remain correctly associated, and no
  testimonials, prices, claims or contact details are invented.
- **Mobile:** at 390px, text and controls remain readable, no horizontal scroll,
  photos preserve their intended shape, and important details are findable.
- **Editability:** change a price, heading and image through the real editor.
  Add a block, undo it, save locally, and verify the served content.
- **Next action:** within five seconds, can a newcomer identify how to contact,
  attend or continue? Do visible links and controls actually do what they imply?

Keep the per-case checklist alongside those scores. Automated term checks are
only clues: a model may format 18000 as 18,000, and merely mentioning all facts
does not prove that they are correctly paired. Inspect the page itself.

## Comparing models and releases

Start with cafe-en, photo-preservation and iterative-page. Run the same prompt,
fixture and settings for each model. Repeat a case three times before treating a
small difference as meaningful. Record failures too, including incomplete output,
rejected sanitisation, retries, total spend and waiting time.

Reject a result regardless of its total score if it invents a business fact,
loses an existing photo, leaves an important control inert, cannot be edited,
or becomes unreadable on mobile. Keep screenshots and output HTML as regression
examples. Do not turn this into an automatic publication step.

No live model scores are supplied with this corpus. They must come from actual
runs, followed by the human review above.
