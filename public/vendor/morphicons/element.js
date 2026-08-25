import { n as createController, t as computeInitialD } from "./controller-CXZuwJ_M.js";
//#region src/element/index.ts
const SVG_NS = "http://www.w3.org/2000/svg";
const REACTIVE = [
	"icon",
	"from",
	"to",
	"progress",
	"spring",
	"reducedMotion"
];
const PRESENTATION = /* @__PURE__ */ new Set([
	"size",
	"color",
	"stroke-width",
	"absolute-stroke-width",
	"label"
]);
const Base = typeof HTMLElement === "undefined" ? class {} : HTMLElement;
var MorphIconElement = class extends Base {
	static observedAttributes = [
		"icon",
		"from",
		"to",
		"progress",
		"spring",
		"reduced-motion",
		"size",
		"color",
		"stroke-width",
		"absolute-stroke-width",
		"label"
	];
	#props = {};
	#ctrl = null;
	#path = null;
	#adopted = false;
	#preConnectDirty = false;
	#size = "24";
	#color = "currentColor";
	#strokeWidth = "2";
	#absoluteStrokeWidth = false;
	#label = null;
	get icon() {
		return this.#props.icon;
	}
	set icon(v) {
		this.#props.icon = v;
		this.#watch();
	}
	get from() {
		return this.#props.from;
	}
	set from(v) {
		this.#props.from = v;
		this.#watch();
	}
	get to() {
		return this.#props.to;
	}
	set to(v) {
		this.#props.to = v;
		this.#watch();
	}
	get progress() {
		return this.#props.progress;
	}
	set progress(v) {
		this.#props.progress = v;
		this.#watch();
	}
	get spring() {
		return this.#props.spring;
	}
	set spring(v) {
		this.#props.spring = v;
		this.#watch();
	}
	get reducedMotion() {
		return this.#props.reducedMotion;
	}
	set reducedMotion(v) {
		this.#props.reducedMotion = v;
		this.#watch();
	}
	morphTo(icon, spring) {
		const ctrl = this.#ctrl;
		if (!ctrl) {
			this.#imperativeBeforeDriver(icon);
			return;
		}
		ctrl.morphTo(icon, spring ?? this.#props.spring);
	}
	set(icon) {
		const ctrl = this.#ctrl;
		if (!ctrl) {
			this.#imperativeBeforeDriver(icon);
			return;
		}
		ctrl.set(icon);
	}
	connectedCallback() {
		for (const key of REACTIVE) this.#upgradeProperty(key);
		if (!this.#path) this.#adoptOrRender();
		if (this.style.display === "") this.style.display = "contents";
		if (this.#path && !this.#ctrl) {
			const path = this.#path;
			const gate = this.#adopted && !this.#preConnectDirty;
			this.#adopted = false;
			this.#ctrl = createController(this.#props);
			if (gate) {
				let armed = false;
				const gated = { setAttribute(name, value) {
					if (armed) path.setAttribute(name, value);
				} };
				try {
					this.#ctrl.mount(gated, this.#props);
				} finally {
					armed = true;
				}
			} else this.#ctrl.mount(path, this.#props);
		}
	}
	disconnectedCallback() {
		this.#ctrl?.destroy();
		this.#ctrl = null;
	}
	attributeChangedCallback(name, _old, value) {
		switch (name) {
			case "icon":
				this.#props.icon = value ?? void 0;
				break;
			case "from":
				this.#props.from = value ?? void 0;
				break;
			case "to":
				this.#props.to = value ?? void 0;
				break;
			case "progress": {
				const n = value === null ? NaN : Number(value);
				this.#props.progress = Number.isFinite(n) ? n : void 0;
				break;
			}
			case "spring":
				this.#props.spring = value ?? void 0;
				break;
			case "reduced-motion":
				this.#props.reducedMotion = value ?? void 0;
				break;
			case "size":
				this.#size = value ?? "24";
				break;
			case "color":
				this.#color = value ?? "currentColor";
				break;
			case "stroke-width":
				this.#strokeWidth = value ?? "2";
				break;
			case "absolute-stroke-width":
				this.#absoluteStrokeWidth = value !== null;
				break;
			case "label": this.#label = value;
		}
		if (!this.#path) return;
		if (PRESENTATION.has(name)) {
			const svg = this.querySelector("svg");
			if (svg) this.#applyPresentation(svg);
			return;
		}
		this.#watch();
	}
	/** A property assigned before the element was defined lands as an own
	*  value that shadows the accessor; re-route it through the setter. */
	#upgradeProperty(key) {
		if (Object.hasOwn(this, key)) {
			const self = this;
			const v = self[key];
			delete self[key];
			self[key] = v;
		}
	}
	#watch() {
		const ctrl = this.#ctrl;
		if (!ctrl) {
			this.#preConnectDirty = true;
			return;
		}
		ctrl.watch(this.#props);
	}
	/** Imperative call before the controller exists: adopt the icon as the
	*  mount state AND exit controlled mode — "every imperative call
	*  invalidates the frozen pair" must hold pre-connect too, or a pending
	*  pair would win the mount and silently discard this call. */
	#imperativeBeforeDriver(icon) {
		this.#props.icon = icon;
		this.#props.from = void 0;
		this.#props.to = void 0;
		this.#preConnectDirty = true;
	}
	/** SSR markup is adopted verbatim (the element never rewrites server bytes
	*  at rest); without it, the element renders its own <svg> like the
	*  framework shells do. */
	#adoptOrRender() {
		const existing = this.querySelector("path");
		if (existing) {
			this.#path = existing;
			this.#adopted = true;
			const p = this.#props;
			if (p.icon === void 0 && p.from === void 0 && p.to === void 0) {
				const d = existing.getAttribute("d");
				if (d) p.icon = d;
			}
			return;
		}
		const doc = this.ownerDocument;
		const svg = doc.createElementNS(SVG_NS, "svg");
		svg.setAttribute("xmlns", SVG_NS);
		svg.setAttribute("viewBox", "0 0 24 24");
		svg.setAttribute("fill", "none");
		svg.setAttribute("stroke-linecap", "round");
		svg.setAttribute("stroke-linejoin", "round");
		this.#applyPresentation(svg);
		const path = doc.createElementNS(SVG_NS, "path");
		path.setAttribute("d", computeInitialD(this.#props));
		svg.appendChild(path);
		this.appendChild(svg);
		this.#path = path;
	}
	#applyPresentation(svg) {
		svg.setAttribute("width", this.#size);
		svg.setAttribute("height", this.#size);
		svg.setAttribute("stroke", this.#color);
		const sw = this.#absoluteStrokeWidth ? String(Number(this.#strokeWidth) * 24 / Number(this.#size)) : this.#strokeWidth;
		svg.setAttribute("stroke-width", sw);
		const label = this.#label;
		let title = svg.querySelector("title");
		if (label) {
			svg.setAttribute("role", "img");
			svg.removeAttribute("aria-hidden");
			if (!title) {
				title = this.ownerDocument.createElementNS(SVG_NS, "title");
				svg.insertBefore(title, svg.firstChild);
			}
			title.textContent = label;
		} else {
			svg.removeAttribute("role");
			svg.setAttribute("aria-hidden", "true");
			title?.remove();
		}
	}
};
let registered = false;
/** Defines `<morph-icon>` (or a custom tag). Idempotent per tag; a no-op
*  without a DOM (safe to call from code that also runs during SSR). */
function defineMorphIcon(tag = "morph-icon") {
	if (typeof customElements === "undefined" || customElements.get(tag)) return;
	customElements.define(tag, registered ? class extends MorphIconElement {} : MorphIconElement);
	registered = true;
}
//#endregion
export { MorphIconElement, computeInitialD, defineMorphIcon };
