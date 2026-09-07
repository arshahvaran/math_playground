import { registry } from './viz/registry';

/**
 * Phase 0 entry point.
 *
 * The shell (tab bar, generated control panel, fact card, router) lands in
 * Phase 1 — see docs/WORKFLOW.md. Until then this renders the build banner so
 * the Pages deployment is verifiable end to end before any visualization exists.
 */
const app = document.querySelector<HTMLDivElement>('#app');

if (app) {
  app.innerHTML = `
    <main style="font: 16px/1.6 system-ui, sans-serif; max-width: 44rem; margin: 4rem auto; padding: 0 1.5rem;">
      <h1 style="margin:0 0 .5rem">Math Playground</h1>
      <p style="margin:0 0 2rem; opacity:.7">
        Interactive, parameter-driven visualizations of classic results in probability,
        chaos, and number theory.
      </p>
      <p><strong>Status:</strong> scaffolding complete, ${registry.length} visualizations registered.</p>
      <p>Build pipeline and deployment verified. Implementation begins at Phase 1.</p>
    </main>
  `;
}
