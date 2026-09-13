import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';

/**
 * Lets a child `node` process run the emulator from its TypeScript sources, the way vitest runs
 * them, for the tests that need a process of their own (`main.test.ts`). Loaded with `--import`.
 *
 * Node runs `.ts` files itself but resolves specifiers literally: it does not map the `.js` in
 * `import './config.js'` to `config.ts`, and `@telemetry/shared` would resolve to the package's
 * built `dist/`, which may be stale or missing. The two rules below close that gap; the second is
 * the alias in `vitest.config.ts`. The child also needs `--experimental-transform-types`: the
 * shared package declares parameter properties (`FrameTooLongError`, `ConfigError`), which plain
 * type stripping rejects.
 *
 * Not named `*.test.ts`: the unit project collects those, and a module with no `test()` call would
 * be reported as an empty suite.
 */
const SHARED_SOURCE = new URL('../../../packages/shared/src/index.ts', import.meta.url).href;

registerHooks({
  // eslint-disable-next-line max-params -- Node calls a resolve hook with exactly these three positional arguments
  resolve(specifier, context, nextResolve) {
    if (specifier === '@telemetry/shared') {
      return nextResolve(SHARED_SOURCE, context);
    }
    const parent = context.parentURL;
    if (
      parent?.endsWith('.ts') === true &&
      specifier.startsWith('.') &&
      specifier.endsWith('.js')
    ) {
      const source = new URL(`${specifier.slice(0, -'.js'.length)}.ts`, parent);
      if (existsSync(fileURLToPath(source))) {
        return nextResolve(source.href, context);
      }
    }
    return nextResolve(specifier, context);
  },
});
