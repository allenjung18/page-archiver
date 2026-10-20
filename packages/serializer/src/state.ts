// What the reader had done to the page, written into the frozen clone as attributes, because the
// clone copies attributes and not the live properties a script or the user changed: typed values,
// checked boxes, chosen options, open <details>, and the scroll position of scrolled boxes.

/** Input types whose value is never written into an archive. */
const SECRET_INPUT_TYPES = new Set(["password", "file"]);
const CHECKABLE_INPUT_TYPES = new Set(["checkbox", "radio"]);
/** Input types whose value attribute is their label, not something typed. */
const BUTTON_INPUT_TYPES = new Set(["button", "submit", "reset", "image"]);

/** Copies the live control's state onto its clone. Elements that are not form controls are untouched. */
export function freezeFormState(live: Element, clone: Element): void {
  switch (live.localName) {
    case "input": {
      const input = live as HTMLInputElement;
      const type = (input.getAttribute("type") ?? "text").toLowerCase();
      if (CHECKABLE_INPUT_TYPES.has(type)) toggle(clone, "checked", input.checked);
      else if (SECRET_INPUT_TYPES.has(type)) clone.removeAttribute("value");
      else if (BUTTON_INPUT_TYPES.has(type)) break;
      else clone.setAttribute("value", input.value);
      break;
    }
    case "textarea":
      clone.textContent = (live as HTMLTextAreaElement).value;
      break;
    case "option":
      toggle(clone, "selected", (live as HTMLOptionElement).selected);
      break;
    case "details":
      toggle(clone, "open", (live as HTMLDetailsElement).open);
      break;
  }
}

function toggle(el: Element, name: string, on: boolean): void {
  if (on) el.setAttribute(name, "");
  else el.removeAttribute(name);
}

/** A scrolled box and the descendant the archive scrolls it to. */
export interface ScrollPlan {
  /** padding-left and padding-top for the box's scroll-padding, in CSS px. */
  padding: { left: number; top: number };
  /** The descendant marked as the box's initial scroll target. */
  target: Element;
}

/** Descendants examined when looking for a scroll target. */
const MAX_TARGET_CANDIDATES = 4000;

/**
 * A frozen page has no script to scroll a box back to where it was, but CSS can: a descendant with
 * `scroll-initial-target: nearest` is scrolled to when the page opens, aligned to the box's start
 * edge plus its scroll-padding. Picking a descendant at or after the scroll position and setting
 * scroll-padding to the distance between them lands the box exactly where it was. Returns null for a
 * box that is not scrolled, or one with no usable descendant (browsers without
 * scroll-initial-target open the box unscrolled either way).
 */
export function planScroll(box: Element): ScrollPlan | null {
  if (box.scrollTop <= 0 && box.scrollLeft <= 0) return null;
  const doc = box.ownerDocument;
  if (box === doc.documentElement || box === doc.body) return null;
  const view = doc.defaultView;
  const scrolls = (el: Element) => !!view && /(auto|scroll|hidden)/.test(view.getComputedStyle(el).overflow);
  const origin = box.getBoundingClientRect();
  let best: { el: Element; dx: number; dy: number } | null = null;
  let seen = 0;
  const walk = doc.createTreeWalker(box, NodeFilter.SHOW_ELEMENT, {
    acceptNode(node) {
      if (++seen > MAX_TARGET_CANDIDATES) return NodeFilter.FILTER_REJECT;
      // inside a nested scroll box, the nested box would take the target for itself
      const parent = (node as Element).parentElement;
      if (parent && parent !== box && scrolls(parent)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    const r = (n as Element).getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    // how far the element's start edges are from the box's scrolled-to start edges
    const dy = r.top - origin.top - box.clientTop;
    const dx = r.left - origin.left - box.clientLeft;
    if (dy < 0 || dx < 0) continue;
    if (!best || dy < best.dy || (dy === best.dy && dx < best.dx)) best = { el: n as Element, dx, dy };
    if (dy === 0 && dx === 0) break;
  }
  if (!best) return null;
  return { padding: { left: Math.round(best.dx), top: Math.round(best.dy) }, target: best.el };
}
