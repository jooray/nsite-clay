# A page with a form

Every template is a content page. A page that asks a visitor for something and
shows an answer, such as a search box, a question sent to an API or a paid
request, needs two save rules that a content page never meets. Without them the
owner's next Save publishes one visitor's input or result to every visitor after
them.

The reason is the feature that makes the document a database: a save writes the
live DOM, form state included. A ticked checkbox stays ticked for the next
reader, which is right for a checklist and wrong for a search field.

## The whole pattern

```html
<section id="ask">
  <h2 editable="single-line">Ask a question</h2>
  <p editable>Type a question and the answer appears below.</p>

  <form id="ask-form">
    <label for="question">Your question</label>
    <input id="question" name="question" required nc:no-persist>
    <label><input type="checkbox" id="short" nc:no-persist> Keep it short</label>
    <button type="submit">Ask</button>
  </form>

  <div id="answer" aria-live="polite"></div>
</section>

<script>
  const form = document.getElementById("ask-form");
  const answer = document.getElementById("answer");

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const result = document.createElement("p");
    result.setAttribute("nc:transient", "");   // shown here, never saved
    result.textContent = "Asking…";
    answer.replaceChildren(result);
    try {
      const response = await fetch("https://api.example.com/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question: form.question.value,
          short: document.getElementById("short").checked,
        }),
      });
      result.textContent = (await response.json()).answer;
    } catch {
      result.textContent = "The service did not answer. Try again in a moment.";
    }
  });
</script>
```

## The two rules

**`nc:no-persist` on every control a visitor fills in.** Text inputs, textareas,
checkboxes, radio buttons and selects are otherwise written into the file with
whatever value they hold when the owner saves, and the owner is often a visitor
of their own page too. Password and file inputs are never written, marked or not.

**`nc:transient` on everything the script puts into the page.** Put it on the
nodes the script creates, not on the authored container they go into. The save
removes marked elements, so marking `#answer` itself would delete the container
from the published file, and the page would have nowhere to show the next
answer. Marked nodes are also left out of undo, and they do not count as an edit
for autosave.

`clay="no-save"` removes an element from the saved file the same way. Use it for
authored markup that should exist only while the page runs, and `nc:transient`
for what a script adds at view time.

## Things that follow from it

- **Classes and attributes a script sets are saved too.** A `hidden` class your
  filter puts on cards, or a `data-theme` you apply, is written into the file as
  if someone had authored it. Undo those on the save copy with
  `nc.addDocumentTransform((clone) => { … })`, which cannot affect what the
  reader sees.
- **Check before you publish.** Sign in, use the form, then run `nc.getHTML()`
  in the console. It returns exactly what Save would store; nothing a visitor
  typed or received should be in it.
- **AI editing.** A whole-page AI rewrite cannot keep a form or a custom script
  working, so on such a page Edit with AI offers only the part you clicked. The
  text around the form is still editable by hand and with AI.

The marker table is in [RUNTIME-API.md](RUNTIME-API.md#save-markers), and what
belongs in the document rather than on relays is in [state.md](state.md).
