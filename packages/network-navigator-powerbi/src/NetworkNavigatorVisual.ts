/*
 * Copyright (c) Microsoft
 * All rights reserved.
 * MIT License
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import "powerbi-visuals-tools/templates/visuals/.api/v1.7.0/PowerBI-visuals";

import { default as NetworkNavigatorImpl } from "@essex/network-navigator";
import { INetworkNavigatorNode } from "@essex/network-navigator";
import { INetworkNavigatorSelectableNode } from "./models";
import { UpdateType, receiveDimensions, IDimensions, calcUpdateType } from "@essex/visual-utils";
import converter from "./dataConversion";
import IVisualHost = powerbi.extensibility.visual.IVisualHost;
import VisualUpdateOptions = powerbi.extensibility.visual.VisualUpdateOptions;
import VisualConstructorOptions = powerbi.extensibility.visual.VisualConstructorOptions;
import VisualObjectInstance = powerbi.VisualObjectInstance;
import EnumerateVisualObjectInstancesOptions = powerbi.EnumerateVisualObjectInstancesOptions;
import SelectionId = powerbi.visuals.ISelectionId;
import NetworkNavigatorState from "./state";
import * as $ from "jquery";

/* tslint:disable */
const MY_CSS_MODULE = require("./css/NetworkNavigatorVisual.scss");

// PBI Swallows these
const EVENTS_TO_IGNORE = "mousedown mouseup click focus blur input pointerdown pointerup touchstart touchmove touchdown";

import { DATA_ROLES } from "./constants";

/* tslint:enable */
declare var _: any;

/**
 * A visual which supports the displaying of graph based datasets in power bi
 */
@receiveDimensions
export default class NetworkNavigator implements powerbi.extensibility.visual.IVisual {

    /**
     * My network navigator instance
     */
    public myNetworkNavigator: NetworkNavigatorImpl;

    /**
     * Whether or not css needs loaded
     */
    protected noCss: boolean;

    /**
     * The visual's host
     */
    private host: IVisualHost;

    /**
     * This visuals element
     */
    private element: JQuery;

    /**
     * The selection changed listener for NetworkNavigator
     */
    private selectionChangedListener: { destroy: Function; };

    /**
     * The selection manager, used to sync selection with PowerBI
     */
    private selectionManager: powerbi.extensibility.ISelectionManager;

    /**
     * The internal state of the network navigator
     */
    private _internalState: NetworkNavigatorState;

    /**
     * The list of nodes loaded into the network navigator
     */
    private _nodes: INetworkNavigatorNode[];

    /**
     * The currently loaded dataView
     */
    private _dataView: powerbi.DataView;

    /**
     * The previous update options
     */
    private prevUpdateOptions: powerbi.extensibility.visual.VisualUpdateOptions;

    /**
     * A debounced event listener for when a node is selected through NetworkNavigator
     */
    private onNodeSelected = _.debounce((node: INetworkNavigatorSelectableNode) => {
        const isInternalStateNodeUnset = this._internalState.selectedNodeIndex === undefined;
        const areBothUndefined = !node && isInternalStateNodeUnset;
        const areIndexesEqual = node && this._internalState.selectedNodeIndex === node.index;

        if (areBothUndefined || areIndexesEqual) {
            return;
        }

        this._internalState = this._internalState.receive({ selectedNodeIndex: node ? node.index : undefined });
        this.persistNodeSelection(node as INetworkNavigatorSelectableNode);
        const label = node ? `Select ${node.name}` : "Clear selection";
    }, 100);

    /*
     * Constructor for the network navigator
     */
    constructor(options: VisualConstructorOptions, noCss = false) {
        this.noCss = noCss;
        this.host = options.host;
        this.element = $(`<div style="height: 100%;"></div>`);
        this.selectionManager = options.host.createSelectionManager();

        // Add to the container
        options.element.appendChild(this.element[0]);

        this.selectionManager = this.host.createSelectionManager();

        // Some of the css is in a css module (:local() {....}), this adds the auto generated class to our element
        const className = MY_CSS_MODULE && MY_CSS_MODULE.locals && MY_CSS_MODULE.locals.className;
        if (className) {
            $(options.element).append($("<st" + "yle>" + MY_CSS_MODULE + "</st" + "yle>"));
            this.element.addClass(className);
        }

        this._internalState = NetworkNavigatorState.create<NetworkNavigatorState>();

        this.myNetworkNavigator = new NetworkNavigatorImpl(this.element, 500, 500);
        this.attachEvents();
    }

    /**
     * Update is called for data updates, resizes & formatting changes
     * @param options The update options from PBI
     * @param vm The view model
     * @param type The update type that occurred
     */
    public update(options: VisualUpdateOptions, vm?: any, type?: UpdateType) {
        const updateType = type !== undefined ? type : calcUpdateType(this.prevUpdateOptions, options);
        this.prevUpdateOptions = options;
        const dataView = options.dataViews && options.dataViews.length && options.dataViews[0];
        this._dataView = dataView;
        const dataViewTable = dataView && dataView.table;
        let forceReloadData = false;

        // Some settings have been updated
        if ((updateType & UpdateType.Settings) === UpdateType.Settings) {
            forceReloadData = this.loadSettingsFromPowerBI(dataView);
        }

        // The dataset has been modified, or something has happened that requires us to force reload the data
        if (((updateType & UpdateType.Data) === UpdateType.Data) || forceReloadData) {
            if (dataViewTable) {
                const filterColumn = dataView.metadata.columns.filter(n => n.roles[DATA_ROLES.filterField.name])[0];
                const newData = converter(dataView, this._internalState, filterColumn, () => this.host.createSelectionIdBuilder());
                this.myNetworkNavigator.setData(newData);
            } else {
                this.myNetworkNavigator.setData({
                    links: [],
                    nodes: [],
                });
            }
            this.loadSelectionFromPowerBI();
        }
        this.myNetworkNavigator.redrawLabels();
    }

    /**
     * Sets the dimensions of this visual
     * @param dim The new dimensions
     */
    public setDimensions(dim: IDimensions) {
        if (this.myNetworkNavigator) {
            this.myNetworkNavigator.dimensions = { width: dim.width, height: dim.height };
        }
        if (this.element) {
            this.element.css({ width: dim.width, height: dim.height });
        }
    }

    /**
     * Destroys the visual
     */
    public destroy() {
        this.element.empty();
    }

    /**
     * Enumerates the instances for the objects (settings) that appear in the power bi panel
     */
    public enumerateObjectInstances(options: EnumerateVisualObjectInstancesOptions): powerbi.VisualObjectInstanceEnumeration {
        return this._internalState.buildEnumerationObjects(options.objectName, this._dataView, false);
    }

    /**
     * Persists the given node as the seelcted node
     */
    protected persistNodeSelection(node: INetworkNavigatorSelectableNode) {
        this.host.applyJsonFilter(node ? node.filter : null, "general", "filter");
    }

    /**
     * Loads the selection state from powerbi
     */
    private loadSelectionFromPowerBI() {
        const data = this.myNetworkNavigator.getData();
        const nodes = data && data.nodes;
        const selectedIds = this._internalState.selectedNodeIndex; this.selectionManager.getSelectionIds();

        // For each of the nodes, check to see if their ids are in the selection manager, and
        // mark them as selected
        if (nodes && nodes.length) {
            this._nodes = nodes;
            let updated = false;
            nodes.forEach((n) => {
                const isSelected =
                    !!_.find(selectedIds, (id: SelectionId) => id.equals((<INetworkNavigatorSelectableNode>n).identity));
                if (isSelected !== n.selected) {
                    n.selected = isSelected;
                    updated = true;
                }
            });

            if (updated) {
                this.myNetworkNavigator.redrawSelection();
            }
        }
    }

    /**
     * Handles updating of the settings
     * @param dataView The dataView to load the settings from
     * @returns True if there was some settings changed that requires a data reload
     */
    private loadSettingsFromPowerBI(dataView: powerbi.DataView): boolean {
        const oldState = this._internalState;
        this._internalState = this._internalState.receiveFromPBI(dataView);
        this.myNetworkNavigator.configuration = this._internalState;
        return oldState.maxNodeCount !== this._internalState.maxNodeCount ||
            oldState.labels !== this._internalState.labels;
    }

    /**
     * Attaches the event listeners to the network navigator
     */
    private attachEvents() {
        if (this.myNetworkNavigator) {
            // Cleans up events
            if (this.selectionChangedListener) {
                this.selectionChangedListener.destroy();
            }
            const dispatcher = this.myNetworkNavigator.events;
            this.selectionChangedListener = dispatcher.on("selectionChanged", (node: INetworkNavigatorNode) => this.onNodeSelected(node));
            dispatcher.on("zoomed", ({ scale, translate }: { scale: number, translate: [number, number] }) => {
                this._internalState = this._internalState.receive({scale, translate});
            });

            dispatcher.on("textFilter", (textFilter: string) => {
                this._internalState = this._internalState.receive({ textFilter });
                const label = textFilter && textFilter !== "" ? `Filtered ${textFilter}` : `Cleared text filter`;
            });

            // PowerBI will eat some events, so use this to prevent powerbi from eating them
            this.element.find(".filter-box input").on(EVENTS_TO_IGNORE, (e) => e.stopPropagation());
        }
    }
}
