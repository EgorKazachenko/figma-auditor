// Example runtime.setup module: runs once per browser launch, before surfaces open.
// opera-chat would install its auth mocks here through `serviceWorker.evaluate(...)`.
export default async function setup({ context, contextName, colorScheme }) {
  await context.addInitScript(
    ([name, scheme]) => {
      window.addEventListener("DOMContentLoaded", () => {
        const el = document.createElement("div");
        el.setAttribute("data-testid", "setup-marker");
        el.textContent = `${name}/${scheme}`;
        el.style.cssText = "padding:8px";
        document.body.appendChild(el);
      });
    },
    [contextName, colorScheme],
  );
}
