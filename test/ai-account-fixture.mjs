export async function mockAiAccount(page, state = { balance: 100000 }) {
  await page.route("https://routstr.cypherpunk.today/v1/models", (route) => route.fulfill({
    contentType: "application/json", body: JSON.stringify({ data: [
      { id: "deepseek-v4-1-flash", sats_pricing: { prompt: .000439, completion: .001756 } },
    ] }),
  }));
  await page.route("https://routstr.cypherpunk.today/v1/balance/info", (route) => route.fulfill({
    status: state.status || 200, contentType: "application/json",
    body: JSON.stringify({ balance: state.balance, reserved: state.reserved || 0 }),
  }));
}
