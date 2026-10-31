/**
 * Package entry.
 *
 * The profile row names this package itself (`name: dsh-model-analogs`), because
 * the browser client graph matches a Loader entry to a package only for an exact
 * package specifier — `pkg/subpath` is not resolvable to `<pkg>'s client half`.
 */
export { apply, Config, inject, name } from './plugin.js';
