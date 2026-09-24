import { estimateAiCost } from "./ai-client.js";

export function readinessPanel(ai, parent, { kind = () => "page", chars = () => 0, onChange = () => {}, showCost = true } = {}) {
  const doc = ai.doc, box = doc.createElement("div"); box.className = "nc-ai-readiness";
  const status = doc.createElement("p"); status.className = "nc-hint"; status.setAttribute("role", "status");
  const cost = doc.createElement("p"); cost.className = "nc-hint";
  cost.hidden = !showCost;
  const retry = doc.createElement("button"); retry.type = "button"; retry.textContent = ai.say("balance");
  box.append(status, cost, retry); parent.append(box);
  let checkId = 0, result;
  const fmt = (n) => Number(n.toFixed(2)).toLocaleString(doc.documentElement.lang || "en");
  const draw = () => {
    if (!result) return;
    const amount = result.available === undefined ? "" : `${ai.say("availableCredit")}: ${fmt(result.available)} sats. `;
    retry.hidden = result.session?.mode === "byok";
    status.textContent = amount + ai.say(result.state);
    status.classList.toggle("nc-bad", ["insufficient", "invalidKey", "modelMissing"].includes(result.state));
    const estimate = estimateAiCost(result.pricing, chars(), kind());
    cost.textContent = estimate ? `${ai.say("estimate")}: ${fmt(estimate.low)} … ${fmt(estimate.high)} sats. ` +
      `${fmt(estimate.inputPerK)} / ${fmt(estimate.outputPerK)} ${ai.say("rates")}. ${ai.say("estimateHint")}` +
      (result.available !== undefined && result.available < estimate.low ? ` ${ai.say("lowCredit")}` : "") : ai.say("noPrices");
    onChange(result);
  };
  const refresh = async () => {
    const id = ++checkId;
    status.textContent = ai.say("checkingCredit"); retry.disabled = true;
    onChange({ state: "checking", canGenerate: false });
    const session = ai.client.session();
    const checked = await ai.client.check(session).catch(() => ({ state: "unavailable", canGenerate: !!session.key, session }));
    if (id !== checkId || !box.isConnected) return;
    if (JSON.stringify(session) !== JSON.stringify(ai.client.session())) return refresh();
    result = checked;
    retry.disabled = false; draw();
    return result;
  };
  retry.onclick = refresh;
  return { refresh, update: draw, element: box };
}
