// safe-href.mjs — the ~10-line extraction that survives from legion2's `lib/ticket-form.mjs`.
// Everything else in that file was the intake ticket PICKER's state machine — a control surface,
// deleted outright with intake (PLAN-V3 decision 12a). This one rule is presentation and it stays:
//
//   A recorded URL becomes an ANCHOR only when it is http(s). Anything else is inert text.
//
// WHERE IT IS USED, AND WHERE IT DELIBERATELY IS NOT. legion3's manifests record ONE url: the
// merge request's (`mr.url`, written by `legion finalize` from what the forge returned). The
// TICKET is recorded as a REFERENCE STRING — `#42` or `group/proj#42`, kernel/ticket.mjs — and
// legion never derives a URL from it. So the ticket renders as a monospace reference and NOT as a
// link: there is no address to link to, and composing one out of a host guess would be inventing
// the exact kind of value VIEWER-REVIEW H02 forbids.

/** @param {unknown} url @returns {string|null} the url when it is safely linkable, else null */
export const safeHref = (url) => (/^https?:\/\//i.test(String(url ?? '')) ? String(url) : null);
