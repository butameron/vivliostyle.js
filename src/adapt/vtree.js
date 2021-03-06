/**
 * Copyright 2013 Google, Inc.
 * Copyright 2015 Trim-marks Inc.
 *
 * Vivliostyle.js is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * Vivliostyle.js is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with Vivliostyle.js.  If not, see <http://www.gnu.org/licenses/>.
 *
 * @fileoverview Basic view tree data structures and support utilities.
 */
goog.require('vivliostyle.constants');
goog.require('adapt.base');
goog.require('adapt.geom');
goog.require('adapt.task');
goog.require('adapt.taskutil');
goog.require('adapt.xmldoc');
goog.require('adapt.css');

goog.provide('adapt.vtree');


/** @const */
adapt.vtree.delayedProps = {
    "transform": true,
    "transform-origin": true
};

/** @const */
adapt.vtree.delayedPropsIfRelativePositioned = {
    "top": true,
    "bottom": true,
    "left": true,
    "right": true
};

/**
 * @constructor
 * @param {Element} target
 * @param {string} name
 * @param {adapt.css.Val} value
 */
adapt.vtree.DelayedItem = function(target, name, value) {
    this.target = target;
    this.name = name;
    this.value = value;
};


/**
 * "hyperlink" event
 * @typedef {{type:string, target, currentTarget, anchorElement:Element, href:string}}
 */
adapt.vtree.PageHyperlinkEvent;

/**
 * Corresponds to OPS trigger element.
 * @typedef {{observer:string, event:string, action:string, ref:string}}
 */
adapt.vtree.Trigger;

/**
 * @const
 */
adapt.vtree.actions = {
    "show": function(obj) { obj.style.visibility = "visible"; },
    "hide": function(obj) { obj.style.visibility = "hidden"; },
    "play": function(obj) { obj.currentTime = 0; obj.play(); },
    "pause": function(obj) { obj.pause(); },
    "resume": function(obj) { obj.play(); },
    "mute": function(obj) { obj.muted = true; },
    "unmute": function(obj) { obj.muted = false; }
};

/**
 * @param {Array.<Element>} refs
 * @param {string} action
 * @return {?Function}
 */
adapt.vtree.makeListener = (refs, action) => {
    const actionFn = adapt.vtree.actions[action];
    if (actionFn) {
        return () => {
            for (let k = 0; k < refs.length; k++) {
                try {
                    actionFn(refs[k]);
                } catch (err) {
                }
            }
        };
    }
    return null;
};

/**
 * @param {!HTMLElement} container
 * @param {!HTMLElement} bleedBox
 * @constructor
 * @extends {adapt.base.SimpleEventTarget}
 */
adapt.vtree.Page = function(container, bleedBox) {
    adapt.base.SimpleEventTarget.call(this);
    /** @const */ this.container = container;
    /** @const */ this.bleedBox = bleedBox;
    /** @type {HTMLElement} */ this.pageAreaElement = null;
    /** @type {Array.<adapt.vtree.DelayedItem>} */ this.delayedItems = [];
    const self = this;
    /** @param {Event} e */
    this.hrefHandler = e => {
        const anchorElement = /** @type {Element} */ (e.currentTarget);
        const href = anchorElement.getAttribute("href") ||
            anchorElement.getAttributeNS(adapt.base.NS.XLINK, "href");
        if (href) {
            const evt = {
                type: "hyperlink",
                target: null,
                currentTarget: null,
                anchorElement,
                href,
                preventDefault() { e.preventDefault(); }
            };
            self.dispatchEvent(evt);
        }
    };
    /** @const {!Object.<string,Array.<Element>>} */ this.elementsById = {};
    /** @const @type {{width: number, height: number}} */ this.dimensions = {width: 0, height: 0};
    /** @type {boolean} */ this.isFirstPage = false;
    /** @type {boolean} */ this.isLastPage = false;
    /** @type {boolean} */ this.isAutoPageWidth = true;
    /** @type {boolean} */ this.isAutoPageHeight = true;
    /** @type {number} */ this.spineIndex = 0;
    /** @type {adapt.vtree.LayoutPosition} */ this.position = null;
    /** @type {number} */ this.offset = -1;
    /** @type {?vivliostyle.constants.PageSide} */ this.side = null;
    /** @type {Array.<adapt.taskutil.Fetcher>} */ this.fetchers = [];
    /** @const @type {{top: !Object.<string, adapt.vtree.Container>, bottom: !Object.<string, adapt.vtree.Container>, left: !Object.<string, adapt.vtree.Container>, right: !Object.<string, adapt.vtree.Container>}} */
    this.marginBoxes = {
        top: {},
        bottom: {},
        left: {},
        right: {}
    };
};
goog.inherits(adapt.vtree.Page, adapt.base.SimpleEventTarget);

/**
 * @private
 * @const
 * @type {string}
 */
adapt.vtree.Page.AUTO_PAGE_WIDTH_ATTRIBUTE = "data-vivliostyle-auto-page-width";

/**
 * @private
 * @const
 * @type {string}
 */
adapt.vtree.Page.AUTO_PAGE_HEIGHT_ATTRIBUTE = "data-vivliostyle-auto-page-height";

/**
 * @param {boolean} isAuto
 */
adapt.vtree.Page.prototype.setAutoPageWidth = function(isAuto) {
    this.isAutoPageWidth = isAuto;
    if (isAuto) {
        this.container.setAttribute(adapt.vtree.Page.AUTO_PAGE_WIDTH_ATTRIBUTE, true);
    } else {
        this.container.removeAttribute(adapt.vtree.Page.AUTO_PAGE_WIDTH_ATTRIBUTE);
    }
};

/**
 * @param {boolean} isAuto
 */
adapt.vtree.Page.prototype.setAutoPageHeight = function(isAuto) {
    this.isAutoPageHeight = isAuto;
    if (isAuto) {
        this.container.setAttribute(adapt.vtree.Page.AUTO_PAGE_HEIGHT_ATTRIBUTE, true);
    } else {
        this.container.removeAttribute(adapt.vtree.Page.AUTO_PAGE_HEIGHT_ATTRIBUTE);
    }
};

/**
 * @param {Element} element
 * @param {string} id
 */
adapt.vtree.Page.prototype.registerElementWithId = function(element, id) {
    const arr = this.elementsById[id];
    if (!arr) {
        this.elementsById[id] = [element];
    } else {
        arr.push(element);
    }
};

/**
 * @param {Array.<adapt.vtree.Trigger>} triggers
 * @param {adapt.vtree.ClientLayout} clientLayout
 * @return {void}
 */
adapt.vtree.Page.prototype.finish = function(triggers, clientLayout) {
    // Remove ID of elements which eventually did not fit in the page
    // (Some nodes may have been removed after registration if they did not fit in the page)
    Object.keys(this.elementsById).forEach(function(id) {
        const elems = this.elementsById[id];
        for (let i = 0; i < elems.length;) {
            if (this.container.contains(elems[i])) {
                i++;
            } else {
                elems.splice(i, 1);
            }
        }
        if (elems.length === 0) {
            delete this.elementsById[id];
        }
    }, this);

    const list = this.delayedItems;
    for (var i = 0; i < list.length; i++) {
        const item = list[i];
        if (item.target === this.container && item.name === "transform" && !this.isAutoPageWidth && !this.isAutoPageHeight) {
            // When fixed page size is specified, cancel the transform property
            // set at OPFView.makePage() for the specified viewport size
            // (e.g. `<meta name="viewport" content="width=1307, height=1920"/>`)
            // to avoid wrong page resizing.
            continue;
        }
        adapt.base.setCSSProperty(item.target, item.name, item.value.toString());
    }

    // use size of the container of the PageMasterInstance
    const rect = clientLayout.getElementClientRect(this.container);
    this.dimensions.width = rect.width;
    this.dimensions.height = rect.height;

    for (var i = 0; i < triggers.length; i++) {
        const trigger = triggers[i];
        const refs = this.elementsById[trigger.ref];
        const observers = this.elementsById[trigger.observer];
        if (refs && observers) {
            const listener = adapt.vtree.makeListener(refs, trigger.action);
            if (listener) {
                for (let k = 0; k < observers.length; k++) {
                    observers[k].addEventListener(trigger.event, listener, false);
                }
            }
        }
    }
};

/**
 * Zoom page.
 * @param {number} scale Factor to which the page will be scaled.
 */
adapt.vtree.Page.prototype.zoom = function(scale) {
    adapt.base.setCSSProperty(this.container, "transform", `scale(${scale})`);
};

/**
 * Returns the page area element.
 * @returns {!HTMLElement}
 */
adapt.vtree.Page.prototype.getPageAreaElement = function() {
    return this.pageAreaElement || this.container;
};

/**
 * @typedef {{left: adapt.vtree.Page, right: adapt.vtree.Page}}
 */
adapt.vtree.Spread;

/**
 * Marks an element as "special". It should not be used in bbox calculations.
 * @const
 */
adapt.vtree.SPECIAL_ATTR = "data-adapt-spec";


/**
 * Handling of purely whitespace sequences between blocks
 * @enum {number}
 */
adapt.vtree.Whitespace = {
    IGNORE: 0,  // Whitespace sequence between blocks is ignored
    NEWLINE: 1, // Whitespace sequence between blocks is ignored unless it containes newline
    PRESERVE: 2 // Whitespace sequence between blocks is preserved
};

/**
 * Resolves adapt.vtree.Whitespace value from a value of 'white-space' property
 * @param {string} whitespace The value of 'white-space' property
 * @returns {?adapt.vtree.Whitespace}
 */
adapt.vtree.whitespaceFromPropertyValue = whitespace => {
    switch (whitespace) {
        case "normal" :
        case "nowrap" :
            return adapt.vtree.Whitespace.IGNORE;
        case "pre-line" :
            return adapt.vtree.Whitespace.NEWLINE;
        case "pre" :
        case "pre-wrap" :
            return adapt.vtree.Whitespace.PRESERVE;
        default:
            return null;
    }
};

/**
 * @param {Node} node
 * @param {adapt.vtree.Whitespace} whitespace
 * @return {boolean}
 */
adapt.vtree.canIgnore = (node, whitespace) => {
    if (node.nodeType == 1)
        return false;
    const text = node.textContent;
    switch (whitespace) {
        case adapt.vtree.Whitespace.IGNORE:
            return !!text.match(/^\s*$/);
        case adapt.vtree.Whitespace.NEWLINE:
            return !!text.match(/^[ \t\f]*$/);
        case adapt.vtree.Whitespace.PRESERVE:
            return text.length == 0;
    }
    throw new Error(`Unexpected whitespace: ${whitespace}`);
};

/**
 * @param {string} flowName
 * @param {?string} parentFlowName
 * @constructor
 */
adapt.vtree.Flow = function(flowName, parentFlowName) {
    /** @const */ this.flowName = flowName;
    /** @const */ this.parentFlowName = parentFlowName;
    /** @const */ this.forcedBreakOffsets = /** @type {Array<number>} */ ([]);
    /** @type {?adapt.vtree.FormattingContext} */ this.formattingContext = null;
};

/**
 * @param {string} flowName
 * @param {!Element} element
 * @param {number} startOffset
 * @param {number} priority
 * @param {number} linger
 * @param {boolean} exclusive
 * @param {boolean} repeated
 * @param {boolean} last
 * @param {?string} breakBefore
 * @constructor
 */
adapt.vtree.FlowChunk = function(flowName, element, startOffset,
    priority, linger, exclusive, repeated, last, breakBefore) {
    /** @type {string} */ this.flowName = flowName;
    /** @type {!Element} */ this.element = element;
    /** @type {number} */ this.startOffset = startOffset;
    /** @type {number} */ this.priority = priority;
    /** @type {number} */ this.linger = linger;
    /** @type {boolean} */ this.exclusive = exclusive;
    /** @type {boolean} */ this.repeated = repeated;
    /** @type {boolean} */ this.last = last;
    /** @type {number} */ this.startPage = -1;
    /** @type {?string} */ this.breakBefore = breakBefore;
};

/**
 * @param {adapt.vtree.FlowChunk} other
 * @return {boolean}
 */
adapt.vtree.FlowChunk.prototype.isBetter = function(other) {
    if (!this.exclusive)
        return false;
    if (!other.exclusive)
        return true;
    if (this.priority > other.priority)
        return true;
    return this.last;
};

/**
 * @typedef {{
 *   left: number,
 *   top: number,
 *   right: number,
 *   bottom: number,
 *   width: number,
 *   height: number
 * }}
 */
adapt.vtree.ClientRect;

/**
 * @param {adapt.vtree.ClientRect} r1
 * @param {adapt.vtree.ClientRect} r2
 * @return {number}
 */
adapt.vtree.clientrectIncreasingTop = (r1, r2) => r1.top - r2.top;

/**
 * @param {adapt.vtree.ClientRect} r1
 * @param {adapt.vtree.ClientRect} r2
 * @return {number}
 */
adapt.vtree.clientrectDecreasingRight = (r1, r2) => r2.right - r1.right;

/**
 * Interface to read the position assigned to the elements and ranges by the
 * browser.
 * @interface
 */
adapt.vtree.ClientLayout = function() {};

/**
 * @param {Range} range
 * @return {Array.<adapt.vtree.ClientRect>}
 */
adapt.vtree.ClientLayout.prototype.getRangeClientRects = range => {};

/**
 * @param {Element} element
 * @return {adapt.vtree.ClientRect}
 */
adapt.vtree.ClientLayout.prototype.getElementClientRect = element => {};

/**
 * @param {Element} element
 * @return {CSSStyleDeclaration} element's computed style
 */
adapt.vtree.ClientLayout.prototype.getElementComputedStyle = element => {};

/**
 * Styling, creating a single node's view, etc.
 * @interface
 */
adapt.vtree.LayoutContext = function() {};

/**
 * Creates a functionally equivalent, but uninitialized layout context,
 * suitable for building a separate column.
 * @return {!adapt.vtree.LayoutContext}
 */
adapt.vtree.LayoutContext.prototype.clone = () => {};

/**
 * Set the current source node and create a view. Parameter firstTime
 * is true (and possibly offsetInNode > 0) if node was broken on
 * the previous page.
 * @param {adapt.vtree.NodeContext} nodeContext
 * @param {boolean} firstTime
 * @param {boolean=} atUnforcedBreak
 * @return {!adapt.task.Result.<boolean>} true if children should be processed as well
 */
adapt.vtree.LayoutContext.prototype.setCurrent = (nodeContext, firstTime, atUnforcedBreak) => {};

/**
 * Set the container element that holds view elements produced from the source.
 * @param {Element} container
 * @param {boolean} isFootnote
 */
adapt.vtree.LayoutContext.prototype.setViewRoot = (container, isFootnote) => {};

/**
 * Moves to the next view node, creating it and appending it to the view tree if needed.
 * @param {adapt.vtree.NodeContext} nodeContext
 * @param {boolean=} atUnforcedBreak
 * @return {!adapt.task.Result.<adapt.vtree.NodeContext>} that corresponds to the next view node
 */
adapt.vtree.LayoutContext.prototype.nextInTree = (nodeContext, atUnforcedBreak) => {};

/**
 * Apply pseudo-element styles (if any).
 * @param {adapt.vtree.NodeContext} nodeContext
 * @param {string} pseudoName
 * @param {Element} element element to apply styles to
 * @return {void}
 */
adapt.vtree.LayoutContext.prototype.applyPseudoelementStyle = (nodeContext, pseudoName, element) => {};

/**
 * Apply styles to footnote container.
 * @param {boolean} vertical
 * @param {boolean} rtl
 * @param {Element} element element to apply styles to
 * @return {boolean} vertical
 */
adapt.vtree.LayoutContext.prototype.applyFootnoteStyle = (vertical, rtl, element) => {};


/**
 * Peel off innermost first-XXX pseudoelement, create and create view nodes after
 * the end of that pseudoelement.
 * @param {adapt.vtree.NodeContext} nodeContext
 * @param {number} nodeOffset
 * @return {!adapt.task.Result.<adapt.vtree.NodeContext>}
 */
adapt.vtree.LayoutContext.prototype.peelOff = (nodeContext, nodeOffset) => {};

/**
 * Process a block-end edge of a fragmented block.
 * @param {adapt.vtree.NodeContext} nodeContext
 */
adapt.vtree.LayoutContext.prototype.processFragmentedBlockEdge = nodeContext => {};

/**
 * @param {!adapt.css.Numeric} numeric
 * @param {Node} viewNode
 * @param {!adapt.vtree.ClientLayout} clientLayout
 * @return {number|!adapt.css.Numeric}
 */
adapt.vtree.LayoutContext.prototype.convertLengthToPx = (numeric, viewNode, clientLayout) => {};

/**
 * Returns if two NodePositions represents the same position in the document.
 * @param {!adapt.vtree.NodePosition} nodePosition1
 * @param {!adapt.vtree.NodePosition} nodePosition2
 * @return {boolean}
 */
adapt.vtree.LayoutContext.prototype.isSameNodePosition = (nodePosition1, nodePosition2) => {};

/**
 * @param {string} type
 * @param {adapt.base.EventListener} listener
 * @param {boolean=} capture
 * @return {void}
 */
adapt.vtree.LayoutContext.prototype.addEventListener = (type, listener, capture) => {};

/**
 * @param {string} type
 * @param {adapt.base.EventListener} listener
 * @param {boolean=} capture
 * @return {void}
 */
adapt.vtree.LayoutContext.prototype.removeEventListener = (type, listener, capture) => {};

/**
 * @param {adapt.base.Event} evt
 * @return {void}
 */
adapt.vtree.LayoutContext.prototype.dispatchEvent = evt => {};

/**
 * Formatting context.
 * @interface
 */
adapt.vtree.FormattingContext = function() {};

/**
 * @return {string}
 */
adapt.vtree.FormattingContext.prototype.getName = () => {};

/**
 * @param {!adapt.vtree.NodeContext} nodeContext
 * @param {boolean} firstTime
 * @return {boolean}
 */
adapt.vtree.FormattingContext.prototype.isFirstTime = (nodeContext, firstTime) => {};

/**
 * @return {adapt.vtree.FormattingContext}
 */
adapt.vtree.FormattingContext.prototype.getParent = () => {};

/**
 * @return {*}
 */
adapt.vtree.FormattingContext.prototype.saveState = () => {};

/**
 * @param {*} state
 */
adapt.vtree.FormattingContext.prototype.restoreState = state => {};


/**
 * @param {adapt.vtree.NodeContext} nodeContext
 * @param {function(adapt.vtree.FormattingContext)} callback
 */
adapt.vtree.eachAncestorFormattingContext = (nodeContext, callback) => {
    if (!nodeContext) return;
    for (let fc = nodeContext.formattingContext; fc; fc = fc.getParent()) {
        callback(fc);
    }
};

/**
 * @typedef {{
 * 		node:Node,
 *      shadowType:adapt.vtree.ShadowType,
 *      shadowContext:adapt.vtree.ShadowContext,
 *      nodeShadow:adapt.vtree.ShadowContext,
 *      shadowSibling:adapt.vtree.NodePositionStep,
 *      formattingContext:adapt.vtree.FormattingContext,
 *      fragmentIndex: number
 * }}
 */
adapt.vtree.NodePositionStep;

/**
 * @param {adapt.vtree.NodePositionStep} nps1
 * @param {adapt.vtree.NodePositionStep} nps2
 * @returns {boolean}
 */
adapt.vtree.isSameNodePositionStep = (nps1, nps2) => {
    if (nps1 === nps2) {
        return true;
    }
    if (!nps1 || !nps2) {
        return false;
    }
    return nps1.node === nps2.node &&
        nps1.shadowType === nps2.shadowType &&
        adapt.vtree.isSameShadowContext(nps1.shadowContext, nps2.shadowContext) &&
        adapt.vtree.isSameShadowContext(nps1.nodeShadow, nps2.nodeShadow) &&
        adapt.vtree.isSameNodePositionStep(nps1.shadowSibling, nps2.shadowSibling);
};

/**
 * NodePosition represents a position in the document
 * @typedef {{
 * 		steps:Array.<adapt.vtree.NodePositionStep>,
 * 		offsetInNode:number,
 *  	after:boolean,
 *  	preprocessedTextContent:?Array.<vivliostyle.diff.Change>
 * }}
 */
adapt.vtree.NodePosition;

/**
 * @param {?adapt.vtree.NodePosition} np1
 * @param {?adapt.vtree.NodePosition} np2
 * @returns {boolean}
 */
adapt.vtree.isSameNodePosition = (np1, np2) => {
    if (np1 === np2) {
        return true;
    }
    if (!np1 || !np2) {
        return false;
    }
    if (np1.offsetInNode !== np2.offsetInNode || np1.after !== np2.after || np1.steps.length !== np2.steps.length) {
        return false;
    }
    for (let i = 0; i < np1.steps.length; i++) {
        if (!adapt.vtree.isSameNodePositionStep(np1.steps[i], np2.steps[i])) {
            return false;
        }
    }
    return true;
};

/**
 * @param {Node} node
 * @return {adapt.vtree.NodePosition}
 */
adapt.vtree.newNodePositionFromNode = node => {
    const step = {
        node,
        shadowType: adapt.vtree.ShadowType.NONE,
        shadowContext: null,
        nodeShadow: null,
        shadowSibling: null,
        fragmentIndex: 0
    };
    return {steps:[step], offsetInNode:0, after:false, preprocessedTextContent:null};
};

/**
 * @param {adapt.vtree.NodeContext} nodeContext
 * @param {?number} initialFragmentIndex
 * @return {adapt.vtree.NodePosition}
 */
adapt.vtree.newNodePositionFromNodeContext = (nodeContext, initialFragmentIndex) => {
    const step = {
        node: nodeContext.sourceNode,
        shadowType: adapt.vtree.ShadowType.NONE,
        shadowContext: nodeContext.shadowContext,
        nodeShadow: null,
        shadowSibling: null,
        fragmentIndex: initialFragmentIndex != null ?  initialFragmentIndex : nodeContext.fragmentIndex
    };
    return {steps:[step], offsetInNode:0, after:false, preprocessedTextContent:nodeContext.preprocessedTextContent};
};

/**
 * @param {adapt.vtree.NodePositionStep} step
 * @param {adapt.vtree.NodeContext} parent
 * @return {!adapt.vtree.NodeContext}
 */
adapt.vtree.makeNodeContextFromNodePositionStep = (step, parent) => {
    const nodeContext = new adapt.vtree.NodeContext(step.node, parent, 0);
    nodeContext.shadowType = step.shadowType;
    nodeContext.shadowContext = step.shadowContext;
    nodeContext.nodeShadow = step.nodeShadow;
    nodeContext.shadowSibling = step.shadowSibling ?
        adapt.vtree.makeNodeContextFromNodePositionStep(step.shadowSibling, parent.copy()) : null;
    nodeContext.formattingContext = step.formattingContext;
    nodeContext.fragmentIndex = step.fragmentIndex+1;
    return nodeContext;
};

/**
 * @enum {number}
 */
adapt.vtree.ShadowType = {
    NONE: 0,
    CONTENT: 1,
    ROOTLESS: 2,
    ROOTED: 3
};

/**
 * Data about shadow tree instance.
 * @param {Element} owner
 * @param {Element} root
 * @param {adapt.xmldoc.XMLDocHolder} xmldoc
 * @param {adapt.vtree.ShadowContext} parentShadow
 * @param {adapt.vtree.ShadowContext} superShadow
 * @param {adapt.vtree.ShadowType} type
 * @param {Object} styler
 * @constructor
 */
adapt.vtree.ShadowContext = function(owner, root, xmldoc, parentShadow, superShadow, type, styler) {
    /** @const */ this.owner = owner;
    /** @const */ this.parentShadow = parentShadow;
    /** @type {adapt.vtree.ShadowContext} */ this.subShadow = null;
    /** @const */ this.root = root;
    /** @const */ this.xmldoc = xmldoc;
    /** @const */ this.type = type;
    if (superShadow) {
        superShadow.subShadow = this;
    }
    /** @const */ this.styler = styler;
};

/**
 * @param {adapt.vtree.ShadowContext} other
 * @returns {boolean}
 */
adapt.vtree.ShadowContext.prototype.equals = function(other) {
    if (!other)
        return false;
    return this.owner === other.owner &&
        this.xmldoc === other.xmldoc &&
        this.type === other.type &&
        adapt.vtree.isSameShadowContext(this.parentShadow, other.parentShadow);
};

/**
 * @param {adapt.vtree.ShadowContext} sc1
 * @param {adapt.vtree.ShadowContext} sc2
 * @returns {boolean}
 */
adapt.vtree.isSameShadowContext = (sc1, sc2) => sc1 === sc2 ||
    (!!sc1 && !!sc2 && sc1.equals(sc2));

/**
 * Information about :first-letter or :first-line pseudoelements
 * @param {adapt.vtree.FirstPseudo} outer
 * @param {number} count 0 - first-letter, 1 or more - first line(s)
 * @constructor
 */
adapt.vtree.FirstPseudo = function(outer, count) {
    /** @const */ this.outer = outer;
    /** @const */ this.count = count;
};

/**
 * NodeContext represents a position in the document + layout-related
 * information attached to it. When after=false and offsetInNode=0, the
 * position is inside the element (node), but just before its first child.
 * When offsetInNode>0 it represents offset in the textual content of the
 * node. When after=true it represents position right after the last child
 * of the node. boxOffset is incremented by 1 for any valid node position.
 * @param {Node} sourceNode
 * @param {adapt.vtree.NodeContext} parent
 * @param {number} boxOffset
 * @constructor
 */
adapt.vtree.NodeContext = function(sourceNode, parent, boxOffset) {
    /** @type {Node} */ this.sourceNode = sourceNode;
    /** @type {adapt.vtree.NodeContext} */ this.parent = parent;
    /** @type {number} */ this.boxOffset = boxOffset;
    // position itself
    /** @type {number} */ this.offsetInNode = 0;
    /** @type {boolean} */ this.after = false;
    /** @type {adapt.vtree.ShadowType} */ this.shadowType = adapt.vtree.ShadowType.NONE;  // parent's shadow type
    /** @type {adapt.vtree.ShadowContext} */ this.shadowContext = (parent ? parent.shadowContext : null);
    /** @type {adapt.vtree.ShadowContext} */ this.nodeShadow = null;
    /** @type {adapt.vtree.NodeContext} */ this.shadowSibling = null;  // next "sibling" in the shadow tree
    // other stuff
    /** @type {boolean} */ this.shared = false;
    /** @type {boolean} */ this.inline = true;
    /** @type {boolean} */ this.overflow = false;
    /** @type {number} */ this.breakPenalty = parent ? parent.breakPenalty : 0;
    /** @type {?string} */ this.display = null;
    /** @type {!vivliostyle.pagefloat.FloatReference} */ this.floatReference =
        vivliostyle.pagefloat.FloatReference.INLINE;
    /** @type {?string} */ this.floatSide = null;
    /** @type {?string} */ this.clearSide = null;
    /** @type {?adapt.css.Numeric} */ this.floatMinWrapBlock = null;
    /** @type {?adapt.css.Val} */ this.columnSpan = null;
    /** @type {string} */ this.verticalAlign = "baseline";
    /** @type {string} */ this.captionSide = "top";
    /** @type {number} */ this.inlineBorderSpacing = 0;
    /** @type {number} */ this.blockBorderSpacing = 0;
    /** @type {boolean} */ this.flexContainer = false;
    /** @type {adapt.vtree.Whitespace} */ this.whitespace = parent ? parent.whitespace : adapt.vtree.Whitespace.IGNORE;
    /** @type {?string} */ this.hyphenateCharacter = parent ? parent.hyphenateCharacter : null;
    /** @type {boolean} */ this.breakWord = parent ? parent.breakWord : false;
    /** @type {boolean} */ this.establishesBFC = false;
    /** @type {boolean} */ this.containingBlockForAbsolute = false;
    /** @type {?string} */ this.breakBefore = null;
    /** @type {?string} */ this.breakAfter = null;
    /** @type {Node} */ this.viewNode = null;
    /** @type {Node} */ this.clearSpacer = null;
    /** @type {Object.<string,number|string|adapt.css.Val>} */ this.inheritedProps = parent ? parent.inheritedProps : {};
    /** @type {boolean} */ this.vertical = parent ? parent.vertical : false;
    /** @type {string} */ this.direction = parent ? parent.direction : "ltr";
    /** @type {adapt.vtree.FirstPseudo} */ this.firstPseudo = parent ? parent.firstPseudo : null;
    /** @type {?string} */ this.lang = null;
    /** @type {?Array.<vivliostyle.diff.Change>} */ this.preprocessedTextContent = null;
    /** @type {adapt.vtree.FormattingContext} */ this.formattingContext = parent ? parent.formattingContext : null;
    /** @type {?string} */ this.repeatOnBreak = null;
    /** @type {Object.<string,(string|number|undefined|null|Array.<?number>)>} */ this.pluginProps = {};
    /** @type {number} */ this.fragmentIndex = 1;
    /** @type {vivliostyle.selectors.AfterIfContinues} */ this.afterIfContinues = null;
    /** @type {?adapt.css.Ident} */ this.footnotePolicy = null;
};

/**
 * @return {void}
 */
adapt.vtree.NodeContext.prototype.resetView = function() {
    this.inline = true;
    this.breakPenalty = this.parent ? this.parent.breakPenalty : 0;
    this.viewNode = null;
    this.clearSpacer = null;
    this.offsetInNode = 0;
    this.after = false;
    this.display = null;
    this.floatReference = vivliostyle.pagefloat.FloatReference.INLINE;
    this.floatSide = null;
    this.clearSide = null;
    this.floatMinWrapBlock = null;
    this.columnSpan = null;
    this.verticalAlign = "baseline";
    this.flexContainer = false;
    this.whitespace = this.parent ? this.parent.whitespace : adapt.vtree.Whitespace.IGNORE;
    this.hyphenateCharacter = this.parent ? this.parent.hyphenateCharacter : null;
    this.breakWord = this.parent ? this.parent.breakWord : false;
    this.breakBefore = null;
    this.breakAfter = null;
    this.nodeShadow = null;
    this.establishesBFC = false;
    this.containingBlockForAbsolute = false;
    this.vertical = this.parent ? this.parent.vertical : false;
    this.nodeShadow = null;
    this.preprocessedTextContent = null;
    this.formattingContext = this.parent ? this.parent.formattingContext : null;
    this.repeatOnBreak = null;
    this.pluginProps = {};
    this.fragmentIndex = 1;
    this.afterIfContinues = null;
    this.footnotePolicy = null;
};

/**
 * @private
 * @return {!adapt.vtree.NodeContext}
 */
adapt.vtree.NodeContext.prototype.cloneItem = function() {
    const np = new adapt.vtree.NodeContext(this.sourceNode, this.parent, this.boxOffset);
    np.offsetInNode = this.offsetInNode;
    np.after = this.after;
    np.nodeShadow = this.nodeShadow;
    np.shadowType = this.shadowType;
    np.shadowContext = this.shadowContext;
    np.shadowSibling = this.shadowSibling;
    np.inline = this.inline;
    np.breakPenalty = this.breakPenalty;
    np.display = this.display;
    np.floatReference = this.floatReference;
    np.floatSide = this.floatSide;
    np.clearSide = this.clearSide;
    np.floatMinWrapBlock = this.floatMinWrapBlock;
    np.columnSpan = this.columnSpan;
    np.verticalAlign = this.verticalAlign;
    np.captionSide = this.captionSide;
    np.inlineBorderSpacing = this.inlineBorderSpacing;
    np.blockBorderSpacing = this.blockBorderSpacing;
    np.establishesBFC = this.establishesBFC;
    np.containingBlockForAbsolute = this.containingBlockForAbsolute;
    np.flexContainer = this.flexContainer;
    np.whitespace = this.whitespace;
    np.hyphenateCharacter = this.hyphenateCharacter;
    np.breakWord = this.breakWord;
    np.breakBefore = this.breakBefore;
    np.breakAfter = this.breakAfter;
    np.viewNode = this.viewNode;
    np.clearSpacer = this.clearSpacer;
    np.firstPseudo = this.firstPseudo;
    np.vertical = this.vertical;
    np.overflow = this.overflow;
    np.preprocessedTextContent = this.preprocessedTextContent;
    np.formattingContext = this.formattingContext;
    np.repeatOnBreak = this.repeatOnBreak;
    np.pluginProps = Object.create(this.pluginProps);
    np.fragmentIndex = this.fragmentIndex;
    np.afterIfContinues = this.afterIfContinues;
    np.footnotePolicy = this.footnotePolicy;
    return np;
};

/**
 * @return {!adapt.vtree.NodeContext}
 */
adapt.vtree.NodeContext.prototype.modify = function() {
    if (!this.shared)
        return this;
    return this.cloneItem();
};

/**
 * @return {!adapt.vtree.NodeContext}
 */
adapt.vtree.NodeContext.prototype.copy = function() {
    let np = this;
    do {
        if (np.shared)
            break;
        np.shared = true;
        np = np.parent;
    } while (np);
    return this;
};

/**
 * @return {adapt.vtree.NodeContext}
 */
adapt.vtree.NodeContext.prototype.clone = function() {
    const np = this.cloneItem();
    let npc = np;
    let npp;
    while ((npp = npc.parent) != null) {
        npp = npp.cloneItem();
        npc.parent = npp;
        npc = npp;
    }
    return np;
};

/**
 * @return {adapt.vtree.NodePositionStep}
 */
adapt.vtree.NodeContext.prototype.toNodePositionStep = function() {
    return {
        node: this.sourceNode,
        shadowType: this.shadowType,
        shadowContext: this.shadowContext,
        nodeShadow: this.nodeShadow,
        shadowSibling: this.shadowSibling ? this.shadowSibling.toNodePositionStep() : null,
        formattingContext: this.formattingContext,
        fragmentIndex: this.fragmentIndex
    };
};

/**
 * @return {adapt.vtree.NodePosition}
 */
adapt.vtree.NodeContext.prototype.toNodePosition = function() {
    let nc = this;
    const steps = [];
    do {
        // We need fully "peeled" path, so don't record first-XXX pseudoelement containers
        if (!nc.firstPseudo || !nc.parent || nc.parent.firstPseudo === nc.firstPseudo) {
            steps.push(nc.toNodePositionStep());
        }
        nc = nc.parent;
    } while (nc);

    const actualOffsetInNode = this.preprocessedTextContent
        ? vivliostyle.diff.resolveOriginalIndex(this.preprocessedTextContent, this.offsetInNode)
        : this.offsetInNode;
    return {
        steps,
        offsetInNode: actualOffsetInNode,
        after: this.after,
        preprocessedTextContent: this.preprocessedTextContent
    };
};

/**
 * @returns {boolean}
 */
adapt.vtree.NodeContext.prototype.isInsideBFC = function() {
    let parent = this.parent;
    while (parent) {
        if (parent.establishesBFC) {
            return true;
        }
        parent = parent.parent;
    }
    return false;
};

/**
 * @returns {adapt.vtree.NodeContext}
 */
adapt.vtree.NodeContext.prototype.getContainingBlockForAbsolute = function() {
    let parent = this.parent;
    while (parent) {
        if (parent.containingBlockForAbsolute) {
            return parent;
        }
        parent = parent.parent;
    }
    return null;
};

/**
 * Walk up NodeContext tree (starting from itself) and call the callback for each block.
 * @param {!function(!adapt.vtree.NodeContext)} callback
 */
adapt.vtree.NodeContext.prototype.walkUpBlocks = function(callback) {
    let nodeContext = this;
    while (nodeContext) {
        if (!nodeContext.inline) {
            callback(nodeContext);
        }
        nodeContext = nodeContext.parent;
    }
};


/**
 * @param {adapt.vtree.FormattingContext} formattingContext
 * @returns {boolean}
 */
adapt.vtree.NodeContext.prototype.belongsTo = function(formattingContext) {
    return this.formattingContext === formattingContext
        && !!this.parent
        && this.parent.formattingContext === formattingContext;
};


/**
 * @param {adapt.vtree.NodePosition} primary
 * @constructor
 */
adapt.vtree.ChunkPosition = function(primary) {
    /** @type {adapt.vtree.NodePosition} */ this.primary = primary;
    /** @type {Array.<adapt.vtree.NodePosition>} */ this.floats = null;
};

/**
 * @return {adapt.vtree.ChunkPosition}
 */
adapt.vtree.ChunkPosition.prototype.clone = function() {
    const result = new adapt.vtree.ChunkPosition(this.primary);
    if (this.floats) {
        result.floats = [];
        for (let i = 0; i < this.floats.length; ++i) {
            result.floats[i] = this.floats[i];
        }
    }
    return result;
};

/**
 * @param {adapt.vtree.ChunkPosition} other
 * @returns {boolean}
 */
adapt.vtree.ChunkPosition.prototype.isSamePosition = function(other) {
    if (!other) {
        return false;
    }
    if (this === other) {
        return true;
    }
    if (!adapt.vtree.isSameNodePosition(this.primary, other.primary)) {
        return false;
    }
    if (this.floats) {
        if (!other.floats || this.floats.length !== other.floats.length) {
            return false;
        }
        for (let i = 0; i < this.floats.length; i++) {
            if (!adapt.vtree.isSameNodePosition(this.floats[i], other.floats[i])) {
                return false;
            }
        }
    } else if (other.floats) {
        return false;
    }
    return true;
};

/**
 * @param {adapt.vtree.ChunkPosition} chunkPosition
 * @param {adapt.vtree.FlowChunk} flowChunk
 * @constructor
 */
adapt.vtree.FlowChunkPosition = function(chunkPosition, flowChunk) {
    /** @type {adapt.vtree.ChunkPosition} */ this.chunkPosition = chunkPosition;
    /** @const */ this.flowChunk = flowChunk;
};

/**
 * @return {adapt.vtree.FlowChunkPosition}
 */
adapt.vtree.FlowChunkPosition.prototype.clone = function() {
    return new adapt.vtree.FlowChunkPosition(this.chunkPosition.clone(),
        this.flowChunk);
};

/**
 * @param {adapt.vtree.FlowChunkPosition} other
 * @returns {boolean}
 */
adapt.vtree.FlowChunkPosition.prototype.isSamePosition = function(other) {
    return !!other && (this === other || this.chunkPosition.isSamePosition(other.chunkPosition));
};

/**
 * @constructor
 */
adapt.vtree.FlowPosition = function() {
    /**
     * @type {Array.<adapt.vtree.FlowChunkPosition>}
     */
    this.positions = [];
    /**
     * @type {string}
     */
    this.startSide = "any";
    /**
     * @type {?string}
     */
    this.breakAfter = null;
};

/**
 * @return {adapt.vtree.FlowPosition}
 */
adapt.vtree.FlowPosition.prototype.clone = function() {
    const newfp = new adapt.vtree.FlowPosition();
    const arr = this.positions;
    const newarr = newfp.positions;
    for (let i = 0; i < arr.length; i++) {
        newarr[i] = arr[i].clone();
    }
    newfp.startSide = this.startSide;
    newfp.breakAfter = this.breakAfter;
    return newfp;
};

/**
 * @param {adapt.vtree.FlowPosition} other
 * @returns {boolean}
 */
adapt.vtree.FlowPosition.prototype.isSamePosition = function(other) {
    if (this === other) {
        return true;
    }
    if (!other || this.positions.length !== other.positions.length) {
        return false;
    }
    for (let i = 0; i < this.positions.length; i++) {
        if (!this.positions[i].isSamePosition(other.positions[i])) {
            return false;
        }
    }
    return true;
};

/**
 * @param {number} offset
 * @return {boolean}
 */
adapt.vtree.FlowPosition.prototype.hasContent = function(offset) {
    return this.positions.length > 0 &&
        this.positions[0].flowChunk.startOffset <= offset;
};

/**
 * @constructor
 */
adapt.vtree.LayoutPosition = function() {
    /**
     * One-based, incremented before layout.
     * @type {number}
     */
    this.page = 0;
    /**
     * @type {!Object<string, adapt.vtree.Flow>}
     */
    this.flows = {};
    /**
     * @type {!Object.<string,adapt.vtree.FlowPosition>}
     */
    this.flowPositions = {};
    /**
     * flowPositions is built up to this offset.
     * @type {number}
     */
    this.highestSeenOffset = 0;
};

/**
 * @return {adapt.vtree.LayoutPosition}
 */
adapt.vtree.LayoutPosition.prototype.clone = function() {
    const newcp = new adapt.vtree.LayoutPosition();
    newcp.page = this.page;
    newcp.highestSeenNode = this.highestSeenNode;
    newcp.highestSeenOffset = this.highestSeenOffset;
    newcp.lookupPositionOffset = this.lookupPositionOffset;
    newcp.flows = this.flows;
    for (const name in this.flowPositions) {
        newcp.flowPositions[name] = this.flowPositions[name].clone();
    }
    return newcp;
};

/**
 * @param {adapt.vtree.LayoutPosition} other
 * @returns {boolean}
 */
adapt.vtree.LayoutPosition.prototype.isSamePosition = function(other) {
    if (this === other) {
        return true;
    }
    if (!other || this.page !== other.page || this.highestSeenOffset !== other.highestSeenOffset) {
        return false;
    }
    const thisFlowNames = Object.keys(this.flowPositions);
    const otherFlowNames = Object.keys(other.flowPositions);
    if (thisFlowNames.length !== otherFlowNames.length) {
        return false;
    }

    for (const flowName of thisFlowNames) {
        if (!this.flowPositions[flowName].isSamePosition(other.flowPositions[flowName])) {
            return false;
        }
    }

    return true;
};

/**
 * @param {string} name flow name.
 * @param {number} offset
 * @return {boolean}
 */
adapt.vtree.LayoutPosition.prototype.hasContent = function(name, offset) {
    const flowPos = this.flowPositions[name];
    if (!flowPos)
        return false;
    return flowPos.hasContent(offset);
};

/**
 * @param {string} name
 * @returns {string}
 */
adapt.vtree.LayoutPosition.prototype.startSideOfFlow = function(name) {
    const flowPos = this.flowPositions[name];
    if (!flowPos)
        return "any";
    return flowPos.startSide;
};

/**
 * @param {string} name
 * @returns {?adapt.vtree.FlowChunk}
 */
adapt.vtree.LayoutPosition.prototype.firstFlowChunkOfFlow = function(name) {
    const flowPos = this.flowPositions[name];
    if (!flowPos)
        return null;
    const flowChunkPosition = flowPos.positions[0];
    if (!flowChunkPosition)
        return null;
    return flowChunkPosition.flowChunk;
};

/**
 * @param {Element} element
 * @constructor
 */
adapt.vtree.Container = function(element) {
    /** @type {Element} */ this.element = element;
    /** @type {number} */ this.left = 0;
    /** @type {number} */ this.top = 0;
    /** @type {number} */ this.marginLeft = 0;
    /** @type {number} */ this.marginRight = 0;
    /** @type {number} */ this.marginTop = 0;
    /** @type {number} */ this.marginBottom = 0;
    /** @type {number} */ this.borderLeft = 0;
    /** @type {number} */ this.borderRight = 0;
    /** @type {number} */ this.borderTop = 0;
    /** @type {number} */ this.borderBottom = 0;
    /** @type {number} */ this.paddingLeft = 0;
    /** @type {number} */ this.paddingRight = 0;
    /** @type {number} */ this.paddingTop = 0;
    /** @type {number} */ this.paddingBottom = 0;
    /** @type {number} */ this.width = 0;
    /** @type {number} */ this.height = 0;
    /** @type {number} */ this.originX = 0;
    /** @type {number} */ this.originY = 0;
    /** @type {Array.<adapt.geom.Shape>} */ this.exclusions = null;
    /** @type {adapt.geom.Shape} */ this.innerShape = null;
    /** @type {number} */ this.computedBlockSize = 0;
    /** @type {number} */ this.snapWidth = 0;
    /** @type {number} */ this.snapHeight = 0;
    /** @type {number} */ this.snapOffsetX = 0;
    /** @type {number} */ this.snapOffsetY = 0;
    /** @type {boolean} */ this.vertical = false;  // vertical writing
};

adapt.vtree.Container.prototype.getInsetTop = function() {
    return this.marginTop + this.borderTop + this.paddingTop;
};

adapt.vtree.Container.prototype.getInsetBottom = function() {
    return this.marginBottom + this.borderBottom + this.paddingBottom;
};

adapt.vtree.Container.prototype.getInsetLeft = function() {
    return this.marginLeft + this.borderLeft + this.paddingLeft;
};

adapt.vtree.Container.prototype.getInsetRight = function() {
    return this.marginRight + this.borderRight + this.paddingRight;
};

adapt.vtree.Container.prototype.getInsetBefore = function() {
    if (this.vertical)
        return this.getInsetRight();
    else
        return this.getInsetTop();
};

adapt.vtree.Container.prototype.getInsetAfter = function() {
    if (this.vertical)
        return this.getInsetLeft();
    else
        return this.getInsetBottom();
};

adapt.vtree.Container.prototype.getInsetStart = function() {
    if (this.vertical)
        return this.getInsetTop();
    else
        return this.getInsetLeft();
};

adapt.vtree.Container.prototype.getInsetEnd = function() {
    if (this.vertical)
        return this.getInsetBottom();
    else
        return this.getInsetRight();
};

/**
 * @param {adapt.vtree.ClientRect} box
 * @return {number}
 */
adapt.vtree.Container.prototype.getBeforeEdge = function(box) {
    return this.vertical ? box.right : box.top;
};

/**
 * @param {adapt.vtree.ClientRect} box
 * @return {number}
 */
adapt.vtree.Container.prototype.getAfterEdge = function(box) {
    return this.vertical ? box.left : box.bottom;
};

/**
 * @param {adapt.vtree.ClientRect} box
 * @return {number}
 */
adapt.vtree.Container.prototype.getStartEdge = function(box) {
    return this.vertical ? box.top : box.left;
};

/**
 * @param {adapt.vtree.ClientRect} box
 * @return {number}
 */
adapt.vtree.Container.prototype.getEndEdge = function(box) {
    return this.vertical ? box.bottom : box.right;
};

/**
 * @param {adapt.vtree.ClientRect} box
 * @return {number}
 */
adapt.vtree.Container.prototype.getInlineSize = function(box) {
    return this.vertical ? box.bottom - box.top : box.right - box.left;
};

/**
 * @param {adapt.vtree.ClientRect} box
 * @return {number}
 */
adapt.vtree.Container.prototype.getBoxSize = function(box) {
    return this.vertical ? box.right - box.left : box.bottom - box.top;
};

/**
 * @return {number}
 */
adapt.vtree.Container.prototype.getBoxDir = function() {
    return this.vertical ? -1 : 1;
};

/**
 * @return {number}
 */
adapt.vtree.Container.prototype.getInlineDir = () => 1;


/**
 * @param {adapt.vtree.Container} other
 * @return {void}
 */
adapt.vtree.Container.prototype.copyFrom = function(other) {
    this.element = other.element;
    this.left = other.left;
    this.top = other.top;
    this.marginLeft = other.marginLeft;
    this.marginRight = other.marginRight;
    this.marginTop = other.marginTop;
    this.marginBottom = other.marginBottom;
    this.borderLeft = other.borderLeft;
    this.borderRight = other.borderRight;
    this.borderTop = other.borderTop;
    this.borderBottom = other.borderBottom;
    this.paddingLeft = other.paddingLeft;
    this.paddingRight = other.paddingRight;
    this.paddingTop = other.paddingTop;
    this.paddingBottom = other.paddingBottom;
    this.width = other.width;
    this.height = other.height;
    this.originX = other.originX;
    this.originY = other.originY;
    this.innerShape = other.innerShape;
    this.exclusions = other.exclusions;
    this.computedBlockSize = other.computedBlockSize;
    this.snapWidth = other.snapWidth;
    this.snapHeight = other.snapHeight;
    this.vertical = other.vertical;
};

/**
 * @param {number} top
 * @param {number} height
 * @return {void}
 */
adapt.vtree.Container.prototype.setVerticalPosition = function(top, height) {
    this.top = top;
    this.height = height;
    adapt.base.setCSSProperty(this.element, "top", `${top}px`);
    adapt.base.setCSSProperty(this.element, "height", `${height}px`);
};

/**
 * @param {number} left
 * @param {number} width
 * @return {void}
 */
adapt.vtree.Container.prototype.setHorizontalPosition = function(left, width) {
    this.left = left;
    this.width = width;
    adapt.base.setCSSProperty(this.element, "left", `${left}px`);
    adapt.base.setCSSProperty(this.element, "width", `${width}px`);
};

/**
 * @param {number} start
 * @param {number} extent
 * @return {void}
 */
adapt.vtree.Container.prototype.setBlockPosition = function(start, extent) {
    if (this.vertical) {
        this.setHorizontalPosition(start + extent * this.getBoxDir(), extent);
    } else {
        this.setVerticalPosition(start, extent);
    }
};

/**
 * @param {number} start
 * @param {number} extent
 * @return {void}
 */
adapt.vtree.Container.prototype.setInlinePosition = function(start, extent) {
    if (this.vertical) {
        this.setVerticalPosition(start, extent);
    } else {
        this.setHorizontalPosition(start, extent);
    }
};

adapt.vtree.Container.prototype.clear = function() {
    const parent = this.element;
    let c;
    while (c = parent.lastChild) {
        parent.removeChild(c);
    }
};

/**
 * @return {adapt.geom.Shape}
 */
adapt.vtree.Container.prototype.getInnerShape = function() {
    const rect = this.getInnerRect();
    if (this.innerShape)
        return this.innerShape.withOffset(rect.x1, rect.y1);
    return adapt.geom.shapeForRect(rect.x1, rect.y1, rect.x2, rect.y2);
};

/**
 * @returns {!adapt.geom.Rect}
 */
adapt.vtree.Container.prototype.getInnerRect = function() {
    const offsetX = this.originX + this.left + this.getInsetLeft();
    const offsetY = this.originY + this.top + this.getInsetTop();
    return new adapt.geom.Rect(offsetX, offsetY, offsetX + this.width, offsetY + this.height);
};

/**
 * @returns {!adapt.geom.Rect}
 */
adapt.vtree.Container.prototype.getPaddingRect = function() {
    const paddingX = this.originX + this.left + this.marginLeft + this.borderLeft;
    const paddingY = this.originY + this.top + this.marginTop + this.borderTop;
    const paddingWidth = this.paddingLeft + this.width + this.paddingRight;
    const paddingHeight = this.paddingTop + this.height + this.paddingBottom;
    return new adapt.geom.Rect(paddingX, paddingY, paddingX + paddingWidth, paddingY + paddingHeight);
};

/**
 * @param {adapt.css.Val} outerShapeProp
 * @param {adapt.expr.Context} context
 * @returns {adapt.geom.Shape}
 */
adapt.vtree.Container.prototype.getOuterShape = function(outerShapeProp, context) {
    const rect = this.getOuterRect();
    return adapt.cssprop.toShape(outerShapeProp, rect.x1, rect.y1,
        rect.x2 - rect.x1, rect.y2 - rect.y1, context);
};

/**
 * @returns {!adapt.geom.Rect}
 */
adapt.vtree.Container.prototype.getOuterRect = function() {
    const outerX = this.originX + this.left;
    const outerY = this.originY + this.top;
    const outerWidth = this.getInsetLeft() + this.width + this.getInsetRight();
    const outerHeight = this.getInsetTop() + this.height + this.getInsetBottom();
    return new adapt.geom.Rect(outerX, outerY, outerX + outerWidth, outerY + outerHeight);
};


/** @typedef {function(!adapt.expr.Val, string, !Document):?Node} */
adapt.vtree.ExprContentListener;

/**
 * @constructor
 * @param {Element} elem
 * @param {adapt.expr.Context} context
 * @param {adapt.css.Val} rootContentValue
 * @param {!adapt.vtree.ExprContentListener} exprContentListener
 * @extends {adapt.css.Visitor}
 */
adapt.vtree.ContentPropertyHandler = function(elem, context, rootContentValue,
    exprContentListener) {
    adapt.css.Visitor.call(this);
    /** @const */ this.elem = elem;
    /** @const */ this.context = context;
    /** @const */ this.rootContentValue = rootContentValue;
    /** @const */ this.exprContentListener = exprContentListener;
};
goog.inherits(adapt.vtree.ContentPropertyHandler, adapt.css.Visitor);

/**
 * @private
 * @param {string} str
 * @param {?Node=} node
 */
adapt.vtree.ContentPropertyHandler.prototype.visitStrInner = function(str, node) {
    if (!node)
        node = this.elem.ownerDocument.createTextNode(str);
    this.elem.appendChild(node);
};

/** @override */
adapt.vtree.ContentPropertyHandler.prototype.visitStr = function(str) {
    this.visitStrInner(str.str);
    return null;
};

/** @override */
adapt.vtree.ContentPropertyHandler.prototype.visitURL = function(url) {
    if (this.rootContentValue.url) {
        this.elem.setAttribute("src", url.url);
    } else {
        const img = this.elem.ownerDocument.createElementNS(adapt.base.NS.XHTML, "img");
        img.setAttribute("src", url.url);
        this.elem.appendChild(img);
    }
    return null;
};

/** @override */
adapt.vtree.ContentPropertyHandler.prototype.visitSpaceList = function(list) {
    this.visitValues(list.values);
    return null;
};

/** @override */
adapt.vtree.ContentPropertyHandler.prototype.visitExpr = function(expr) {
    const ex = expr.toExpr();
    let val = ex.evaluate(this.context);
    if (typeof val === "string") {
        if (ex instanceof adapt.expr.Named) {
            // For env(pub-title) and env(doc-title)
            // Need to unquote the result. To be consistent with cssparse.evaluateExprToCSS()
            val = adapt.cssparse.parseValue(ex.scope, new adapt.csstok.Tokenizer(val, null), "").stringValue();
        }
        goog.asserts.assert(this.elem.ownerDocument);
        const node = this.exprContentListener(ex, val, this.elem.ownerDocument);
        this.visitStrInner(val, node);
    }
    return null;
};

/**
 * @param {adapt.css.Val} val
 * @return {boolean}
 */
adapt.vtree.nonTrivialContent = val => val != null && val !== adapt.css.ident.normal && val !== adapt.css.ident.none
    && val !== adapt.css.ident.inherit;
