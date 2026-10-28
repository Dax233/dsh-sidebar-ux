/**
 * Host half of the sidebar UX bundle.
 *
 * Every surface this plugin adds is browser chrome built from the shipped
 * Client packages: the row menus come from the sidebar's own menu triggers, the
 * session reference reuses the official `@[label](dsh-session:…)` mention, and
 * "open in file manager" goes through the shipped Session Remote. Nothing here
 * needs a Host service, tool, route, or prompt text.
 */
export function apply() {}
