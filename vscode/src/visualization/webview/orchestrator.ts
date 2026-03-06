/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
// Orchestrator: message handling, state, and dispatch to modular renderers.
// Config (elkWorkerUrl) is set by a minimal inline script in HTML before this bundle loads.

import { prepareDataForView } from '../prepareData';
import {
    quickHash,
    buildElementDisplayLabel,
    getNodeColor,
    getNodeBorderStyle,
    getTypeColor,
    isActorElement,
    cloneElements,
    normalizeAttributes,
    getElementProperties,
    formatStereotype,
    normalizeTypeForDisplay,
    isLibraryValidated
} from './shared';
import {
    STRUCTURAL_VIEWS,
    MIN_CANVAS_ZOOM,
    MAX_CANVAS_ZOOM,
    MIN_SYSML_ZOOM,
    MAX_SYSML_ZOOM,
    ORIENTATION_LABELS,
    STATE_LAYOUT_LABELS,
    STATE_LAYOUT_ICONS,
    VIEW_OPTIONS
} from './constants';
import {
    convertToHierarchy,
    isMetadataElement,
    flattenElements,
    extractDocumentation,
    wrapTextToLines,
    truncateLabel,
    countAllElements,
    filterElementsRecursive,
    createLinksFromHierarchy,
    buildEnhancedElementLabel,
    getLibraryChain,
    getLibraryKind,
    slugify
} from './helpers';
import { renderSequenceView as renderSequenceViewModule } from './renderers/sequence';
import { renderIbdView as renderIbdViewModule } from './renderers/ibd';
import { renderActivityView as renderActivityViewModule } from './renderers/activity';
import { renderStateView as renderStateViewModule } from './renderers/state';
import { renderElkTreeView as renderElkTreeViewModule, renderSysMLView as renderSysMLViewModule } from './elk';
import { createMinimapController } from './minimap';
import { createExportHandler } from './export';

    let vscode: { postMessage: (msg: unknown) => void };

    export function initializeOrchestrator(api: { postMessage: (msg: unknown) => void }): void {
        vscode = api;
        vscode.postMessage({ command: 'webviewReady' });
    }

    // ELK Worker URL (must be set before ELK is instantiated)
    const elkWorkerUrl = (typeof window !== 'undefined' && (window).__VIZ_INIT?.elkWorkerUrl) ?? '';

    let currentData = null;
    let currentView = 'general-view';  // SysML v2 general-view as default
    let selectedDiagramIndex = 0; // Track currently selected diagram for multi-diagram views
    let selectedDiagramName = null; // Track selected diagram by name to preserve across updates
    let activityDebugLabels = false; // Toggle for showing debug labels on forks/joins in Activity view
    let lastView = currentView;
    let svg = null;
    let g = null;
    let zoom = null;
    let cy = null;
    let sysmlMode = 'hierarchy';
    let layoutDirection = 'horizontal'; // Universal layout direction: 'horizontal', 'vertical', or 'auto'
    let activityLayoutDirection = 'vertical'; // Action-flow diagrams default to top-down
    let stateLayoutOrientation = 'horizontal'; // State-transition layout: 'horizontal', 'vertical', or 'force'
    let filteredData = null; // Active filter state shared across views
    let isRendering = false;
    let showMetadata = false;
    let showCategoryHeaders = true; // Show category headers in General View
    const sysmlElementLookup = new Map();
    // Legacy pillar view variables (kept for compatibility with old functions)
    const SYSML_PILLARS = [];
    const PILLAR_COLOR_MAP = {};
    const expandedPillars = new Set();
    let pillarOrientation = 'horizontal';
let sysmlToolbarInitialized = false;
let lastPillarStats = {};

    // Minimap controller - getState provided lazily (svg, g, zoom, cy, currentView updated during render)
    const minimapController = createMinimapController(() => ({
        svg,
        g,
        zoom,
        cy,
        currentView
    }));

    // Export handler - uses getCurrentData/getViewState for lazy evaluation
    const exportHandler = createExportHandler({
        getCurrentData: () => currentData,
        getViewState: () => ({ currentView, cy }),
        postMessage: (msg) => vscode && vscode.postMessage(msg)
    });

    // ============== LOADING INDICATOR FUNCTIONALITY ==============
    function showLoading(message = 'Rendering diagram...') {
        const overlay = document.getElementById('loading-overlay');
        const textEl = overlay?.querySelector('.loading-text');
        if (overlay) {
            if (textEl) textEl.textContent = message;
            overlay.classList.remove('hidden');
        }
        // Set cursor to wait/hourglass while loading
        document.body.style.cursor = 'wait';
    }

    function hideLoading() {
        const overlay = document.getElementById('loading-overlay');
        if (overlay) {
            overlay.classList.add('hidden');
        }
        // Reset cursor to default
        document.body.style.cursor = '';
    }

    // ============== MINIMAP (delegated to minimap.ts) ==============
    const updateMinimap = () => minimapController.updateMinimap();

    // Activity Debug Labels toggle
    function setupActivityDebugToggle() {
        const debugBtn = document.getElementById('activity-debug-btn');
        if (!debugBtn) return;

        debugBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            activityDebugLabels = !activityDebugLabels;

            if (activityDebugLabels) {
                debugBtn.classList.add('active');
                debugBtn.style.background = 'var(--vscode-button-background)';
                debugBtn.style.color = 'var(--vscode-button-foreground)';
            } else {
                debugBtn.classList.remove('active');
                debugBtn.style.background = '';
                debugBtn.style.color = '';
            }

            // Re-render current view to apply label changes
            if (currentView === 'action-flow-view') {
                renderVisualization('action-flow-view');
            }
        });
    }

    // Show/hide activity debug button based on current view
    function updateActivityDebugButtonVisibility(view) {
        const debugBtn = document.getElementById('activity-debug-btn');
        if (debugBtn) {
            debugBtn.style.display = (view === 'action-flow-view') ? 'inline-block' : 'none';
        }

        // Show legend button only for Cytoscape-based views
        const legendBtn = document.getElementById('legend-btn');
        const legendPopup = document.getElementById('legend-popup');
        if (legendBtn) {
            const cytoscapeViews = ['general', 'general-view'];
            legendBtn.style.display = cytoscapeViews.includes(view) ? 'inline-block' : 'none';
            // Hide popup when switching away from cytoscape views
            if (!cytoscapeViews.includes(view) && legendPopup) {
                legendPopup.style.display = 'none';
                legendBtn.classList.remove('active');
                legendBtn.style.background = '';
                legendBtn.style.color = '';
            }
        }
    }

    // Initialize minimap on load
    document.addEventListener('DOMContentLoaded', () => minimapController.initMinimap());
    // Initialize activity debug toggle
    document.addEventListener('DOMContentLoaded', setupActivityDebugToggle);
    // ============== END MINIMAP ==============

    // buildEnhancedElementLabel, getLibraryChain, getLibraryKind imported from ./helpers

    // Track manual zoom interactions to preserve user's zoom state
    window.userHasManuallyZoomed = false;

    // Global error handler to catch any JavaScript errors
    window.addEventListener('error', (e) => {
        console.error('JavaScript Error:', e.error?.message || e.message);
    });

    // Track last rendered data to avoid unnecessary re-renders
    let lastDataHash = '';

    window.addEventListener('message', event => {
        const message = event.data;
        switch (message.command) {
            case 'showLoading':
                showLoading(message.message || 'Parsing SysML model...');
                break;
            case 'hideLoading':
                hideLoading();
                break;
            case 'update':
                // Quick hash check - skip render if data unchanged
                const newHash = quickHash({
                    elements: message.elements,
                    relationships: message.relationships
                });

                if (newHash === lastDataHash && currentData) {
                    // Data unchanged, skip expensive re-render
                    hideLoading();
                    return;
                }
                lastDataHash = newHash;

                // Update loading message - parsing is done, now rendering
                showLoading('Rendering diagram...');

                // Preserve selected diagram by name across updates
                // Don't reset selectedDiagramIndex here - let updateDiagramSelector restore it by name
                // selectedDiagramIndex will be updated in updateDiagramSelector if the diagram still exists

                currentData = message;
                filteredData = null; // Reset filter when new data arrives

                // If the extension requested a specific package, apply it
                // before anything else so updateDiagramSelector picks it up.
                if (message.pendingPackageName) {
                    selectedDiagramName = message.pendingPackageName;
                    selectedDiagramIndex = 0; // Will be corrected by updateDiagramSelector
                    currentView = 'general-view';
                } else if (message.currentView) {
                    // Use the view state from the message if provided, otherwise keep current
                    currentView = message.currentView;
                }

                updateActiveViewButton(currentView); // Highlight current view
                try {
                    renderVisualization(currentView);
                } catch (e) {
                    console.error('Error in renderVisualization:', e);
                }
                break;
            case 'changeView':
                // Handle view change request from extension
                if (message.view) {
                    changeView(message.view);
                }
                break;
            case 'selectPackage':
                // Switch to General View and select a specific package in the dropdown
                if (message.packageName) {
                    selectedDiagramName = message.packageName;
                    selectedDiagramIndex = 0; // Will be corrected by updateDiagramSelector
                    changeView('general-view');
                }
                break;
            case 'export':
                if (message.format === 'png') {
                    exportHandler.exportPNG(message.scale || 2);
                } else if (message.format === 'svg') {
                    exportHandler.exportSVG();
                }
                break;
            case 'highlightElement':
                highlightElementInVisualization(message.elementName, message.skipCentering);
                break;
            case 'requestCurrentView':
                // Send back the current view state
                vscode.postMessage({
                    command: 'currentViewResponse',
                    view: currentView
                });
                break;
            case 'exportDiagramForTest':
                // Export current diagram SVG for testing/review (writes to test-output/diagrams/)
                const svgString = exportHandler.getSvgStringForExport();
                vscode.postMessage({
                    command: 'testDiagramExported',
                    viewId: currentView,
                    svgString: svgString ?? ''
                });
                break;
        }
    });

    // Update panel dimensions display
    function updateDimensionsDisplay() {
        const vizElement = document.getElementById('visualization');
        if (vizElement) {
            const width = Math.round(vizElement.clientWidth);
            const height = Math.round(vizElement.clientHeight);
            const statusText = document.getElementById('status-text');
            statusText.innerHTML = 'Panel: ' + width + ' x ' + height + 'px - Resize via VS Code panel';
            document.getElementById('status-bar').style.display = 'flex';

            // Auto-reset status text after 3 seconds (but keep bar visible for filter)
            setTimeout(() => {
                if (statusText.innerHTML.includes('Panel:')) {
                    statusText.textContent = 'Ready • Use filter to search elements';
                }
            }, 3000);
        }
    }

    // Resize handler - only triggers after user stops dragging
    let resizeTimeout;
    let lastRenderedWidth = 0;
    let lastRenderedHeight = 0;

    function handleResize() {
        const vizElement = document.getElementById('visualization');
        if (!vizElement) return;

        const currentWidth = vizElement.clientWidth;
        const currentHeight = vizElement.clientHeight;

        // Clear any pending resize
        clearTimeout(resizeTimeout);

        // Update dimensions display immediately during drag
        updateDimensionsDisplay();

        // If we have a Cytoscape instance and we're in sysml view, just resize it (no debounce needed)
        if (cy && currentView === 'sysml') {
            cy.resize();
            if (!window.userHasManuallyZoomed) {
                cy.fit(cy.elements(), 50);
            }
            lastRenderedWidth = currentWidth;
            lastRenderedHeight = currentHeight;
            return;
        }

        // For all other views, wait until resize stops before re-rendering
        resizeTimeout = setTimeout(() => {
            if (currentWidth !== lastRenderedWidth || currentHeight !== lastRenderedHeight) {
                lastRenderedWidth = currentWidth;
                lastRenderedHeight = currentHeight;

                if (currentData && !isRendering) {
                    renderVisualization(currentView, null, true);
                }
            }
        }, 500);
    }

    // Add keyboard shortcut to show dimensions (Ctrl+D)
    window.addEventListener('keydown', (event) => {
        if (event.ctrlKey && event.key === 'd') {
            event.preventDefault();
            updateDimensionsDisplay();
        }
    });

    // Use ResizeObserver for container size changes (more reliable than window resize)
    if (window.ResizeObserver) {
        const resizeObserver = new ResizeObserver(entries => {
            // Use requestAnimationFrame to avoid layout thrashing
            requestAnimationFrame(() => {
                for (let entry of entries) {
                    if (entry.target.id === 'visualization') {
                        handleResize();
                        break;
                    }
                }
            });
        });

        // Start observing when DOM is ready
        setTimeout(() => {
            const visualizationElement = document.getElementById('visualization');
            if (visualizationElement) {
                // Initialize lastRenderedWidth/Height to prevent spurious re-render on first observe
                lastRenderedWidth = visualizationElement.clientWidth;
                lastRenderedHeight = visualizationElement.clientHeight;
                resizeObserver.observe(visualizationElement);
            }
        }, 100);
    }

    // Also listen to window resize events as a fallback
    // This catches cases where the VS Code panel is resized
    window.addEventListener('resize', () => {
        requestAnimationFrame(() => {
            handleResize();
        });
    });

    // Inline editing for element names in General View
    var activeInlineEdit = null;

    function startInlineEdit(nodeG, elementName, x, y, width) {
        // Cancel any existing inline edit
        if (activeInlineEdit) {
            cancelInlineEdit();
        }

        // Find the name text element within this node
        var nameText = nodeG.select('.node-name-text');
        if (nameText.empty()) {
            // Try to find any text that matches the element name
            nodeG.selectAll('text').each(function() {
                var textEl = d3.select(this);
                if (textEl.text() === elementName || textEl.attr('data-element-name') === elementName) {
                    nameText = textEl;
                }
            });
        }

        if (nameText.empty()) return;

        // Get the text element's position within the node
        var textY = parseFloat(nameText.attr('y')) || 31;
        var fontSize = nameText.style('font-size') || '11px';

        // Hide the original text
        nameText.style('visibility', 'hidden');

        // Create input container inside the node itself (not in main g)
        // Position it to match the text location
        var inputHeight = 20;
        var inputY = textY - inputHeight / 2 - 3;
        var inputPadding = 8;

        // Create foreignObject inside the node group for proper positioning
        var fo = nodeG.append('foreignObject')
            .attr('class', 'inline-edit-container')
            .attr('x', inputPadding)
            .attr('y', inputY)
            .attr('width', width - inputPadding * 2)
            .attr('height', inputHeight + 4);

        var input = fo.append('xhtml:input')
            .attr('type', 'text')
            .attr('value', elementName)
            .attr('class', 'inline-edit-input')
            .style('width', '100%')
            .style('height', inputHeight + 'px')
            .style('font-size', fontSize)
            .style('font-weight', 'bold')
            .style('font-family', 'var(--vscode-editor-font-family)')
            .style('text-align', 'center')
            .style('padding', '2px 4px')
            .style('border', '1px solid var(--vscode-focusBorder)')
            .style('border-radius', '3px')
            .style('background', 'var(--vscode-input-background)')
            .style('color', 'var(--vscode-input-foreground)')
            .style('outline', 'none')
            .style('box-sizing', 'border-box')
            .style('box-shadow', '0 0 0 1px var(--vscode-focusBorder)');

        // Store reference to active edit
        activeInlineEdit = {
            foreignObject: fo,
            input: input,
            nameText: nameText,
            originalName: elementName,
            nodeG: nodeG
        };

        // Focus and select all text
        var inputNode = input.node();
        setTimeout(function() {
            inputNode.focus();
            inputNode.select();
        }, 10);

        // Handle keyboard events
        input.on('keydown', function(event) {
            if (event.key === 'Enter') {
                event.preventDefault();
                commitInlineEdit();
            } else if (event.key === 'Escape') {
                event.preventDefault();
                cancelInlineEdit();
            }
            event.stopPropagation();
        });

        // Handle blur (clicking outside)
        input.on('blur', function() {
            // Small delay to allow Enter key to process first
            setTimeout(function() {
                if (activeInlineEdit) {
                    cancelInlineEdit();
                }
            }, 100);
        });

        // Prevent click from bubbling to node
        input.on('click', function(event) {
            event.stopPropagation();
        });
    }

    function commitInlineEdit() {
        if (!activeInlineEdit) return;

        var newName = activeInlineEdit.input.node().value.trim();
        var oldName = activeInlineEdit.originalName;

        // Clean up UI
        activeInlineEdit.nameText.style('visibility', 'visible');
        activeInlineEdit.foreignObject.remove();

        if (newName && newName !== oldName) {
            // Update the text display immediately for responsiveness
            activeInlineEdit.nameText.text(newName);

            // Send rename command to extension
            vscode.postMessage({
                command: 'renameElement',
                oldName: oldName,
                newName: newName
            });
        }

        activeInlineEdit = null;
    }

    function cancelInlineEdit() {
        if (!activeInlineEdit) return;

        // Restore original text visibility
        activeInlineEdit.nameText.style('visibility', 'visible');
        activeInlineEdit.foreignObject.remove();
        activeInlineEdit = null;
    }

    function clearVisualHighlights() {
        // Remove visual highlights without refreshing the view
        d3.selectAll('.highlighted-element').classed('highlighted-element', false);
        d3.selectAll('.selected').classed('selected', false);

        // Restore original stroke/width from saved data attributes on all node backgrounds
        d3.selectAll('.node-group').style('opacity', null);
        d3.selectAll('.node-group .node-background').each(function() {
            const el = d3.select(this);
            el.style('stroke', el.attr('data-original-stroke') || 'var(--vscode-panel-border)');
            el.style('stroke-width', el.attr('data-original-width') || '1px');
        });
        d3.selectAll('.general-node .node-background').each(function() {
            const el = d3.select(this);
            el.style('stroke', el.attr('data-original-stroke') || 'var(--vscode-panel-border)');
            el.style('stroke-width', el.attr('data-original-width') || '2px');
        });
        d3.selectAll('.ibd-part rect:first-child').each(function() {
            const el = d3.select(this);
            const orig = el.attr('data-original-stroke');
            if (orig) {
                el.style('stroke', orig);
                el.style('stroke-width', el.attr('data-original-width') || '2px');
            }
        });
        d3.selectAll('.graph-node-group').style('opacity', null);
        d3.selectAll('.hierarchy-cell').style('opacity', null);
        if (cy) {
            cy.elements().removeClass('highlighted-sysml');
        }
    }

    function initializeSysMLToolbar() {
        if (sysmlToolbarInitialized) {
            return;
        }
        updateSysMLModeButtons();
        const toolbar = document.getElementById('sysml-toolbar');
        if (!toolbar) {
            return;
        }

        toolbar.querySelectorAll('[data-sysml-mode]').forEach(button => {
            button.addEventListener('click', () => {
                const nextMode = button.getAttribute('data-sysml-mode');
                if (!nextMode || nextMode === sysmlMode) {
                    return;
                }
                sysmlMode = nextMode;
                updateSysMLModeButtons();
                if (currentView === 'sysml') {
                    // Re-render the visualization to properly switch modes
                    // This ensures all elements and edges are correctly shown/hidden
                    renderVisualization('sysml');
                }
            });
        });

        const orientationToggle = document.getElementById('orientation-toggle');
        if (orientationToggle) {
            orientationToggle.addEventListener('click', togglePillarOrientation);
            updateOrientationButton();
        }

        const metadataCheckbox = document.getElementById('metadata-checkbox');
        if (metadataCheckbox) {
            metadataCheckbox.addEventListener('change', toggleMetadataDisplay);
            updateMetadataCheckbox();
        }

        sysmlToolbarInitialized = true;
    }

    function setSysMLToolbarVisible(isVisible) {
        const toolbar = document.getElementById('sysml-toolbar');
        if (!toolbar) {
            return;
        }
        if (isVisible) {
            toolbar.classList.add('visible');
            initializeSysMLToolbar();
        } else {
            toolbar.classList.remove('visible');
        }
    }

    function updateSysMLModeButtons() {
        document.querySelectorAll('[data-sysml-mode]').forEach(button => {
            const isActive = button.getAttribute('data-sysml-mode') === sysmlMode;
            button.classList.toggle('active', isActive);
        });

        // Show Layout button only in hierarchy mode
        const layoutButton = document.getElementById('orientation-toggle');
        if (layoutButton) {
            layoutButton.style.display = sysmlMode === 'hierarchy' ? 'inline-block' : 'none';
        }
    }

    function togglePillarOrientation() {
        pillarOrientation = pillarOrientation === 'horizontal' ? 'linear' : 'horizontal';
        updateOrientationButton();
        if (currentView === 'sysml') {
            if (pillarOrientation === 'horizontal') {
                document.getElementById('status-text').textContent = 'SysML Pillar View • Horizontal layout';
            } else {
                document.getElementById('status-text').textContent = 'SysML Pillar View • Linear top-down layout';
            }
            runSysMLLayout(true);
        }
    }

    function updateOrientationButton() {
        const button = document.getElementById('orientation-toggle');
        if (!button) {
            return;
        }
        const isLinear = pillarOrientation === 'linear';
        button.classList.toggle('active', isLinear);
        button.textContent = 'Layout: ' + ORIENTATION_LABELS[pillarOrientation];
        button.setAttribute('aria-pressed', isLinear ? 'true' : 'false');
        button.title = isLinear
            ? 'Switch to horizontal layout'
            : 'Switch to linear (top-down) layout';
    }

    function toggleMetadataDisplay() {
        showMetadata = !showMetadata;
        updateMetadataCheckbox();
        updateNodeLabels();
    }

    function updateMetadataCheckbox() {
        const checkbox = document.getElementById('metadata-checkbox');
        if (!checkbox) {
            return;
        }
        checkbox.checked = showMetadata;
    }

    function updateNodeLabels() {
        if (!cy) {
            return;
        }

        cy.batch(function() {
            cy.nodes('[type = "element"]').forEach(function(node) {
                const baseLabel = node.data('baseLabel');
                const metadata = node.data('metadata');

                if (showMetadata && metadata) {
                    // Build SysML-style label with metadata
                    const parts = [baseLabel];

                    // Add documentation if available
                    if (metadata.documentation) {
                        const docText = String(metadata.documentation);
                        const docShort = docText.length > 50
                            ? docText.substring(0, 47) + '...'
                            : docText;
                        // Escape quotes in documentation
                        const escapedDoc = docShort.replace(/"/g, '\\"');
                        parts.push('doc: "' + escapedDoc + '"');
                    }

                    // Add key properties
                    if (metadata.properties && Object.keys(metadata.properties).length > 0) {
                        const propEntries = Object.entries(metadata.properties).slice(0, 3);
                        propEntries.forEach(function(entry) {
                            const key = entry[0];
                            const value = entry[1];
                            const valStr = String(value);
                            const shortVal = valStr.length > 20 ? valStr.substring(0, 17) + '...' : valStr;
                            parts.push(key + ': ' + shortVal);
                        });
                    }

                    node.data('label', parts.join('\\n'));
                    // Increase text-max-width and padding to accommodate more content
                    node.style({
                        'text-max-width': 300,
                        'padding': '24px',
                        'width': 'label',
                        'height': 'label',
                        'min-width': '160px',
                        'min-height': '90px',
                        'line-height': 1.6
                    });
                } else {
                    // Show only base label
                    node.data('label', baseLabel);
                    // Reset to default size
                    node.style({
                        'text-max-width': 180,
                        'padding': '20px',
                        'width': 'label',
                        'height': 'label',
                        'min-width': '100px',
                        'min-height': '60px',
                        'line-height': 1.5
                    });
                }
            });
        });

        // Re-run layout to accommodate new node sizes and prevent overlaps
        // Use fit=true to ensure all nodes are repositioned properly
        if (currentView === 'sysml') {
            // Force Cytoscape to recalculate and render before layout
            cy.forceRender();
            // Give Cytoscape time to recalculate node dimensions with new content
            setTimeout(() => {
                runSysMLLayout(true);
            }, 150);
        }
    }

    function renderPillarChips(stats = lastPillarStats) {
        const container = document.getElementById('pillar-chips');
        if (!container) {
            return;
        }
        container.innerHTML = '';

        SYSML_PILLARS.forEach(pillar => {
            const chip = document.createElement('button');
            chip.className = 'pillar-chip' + (expandedPillars.has(pillar.id) ? '' : ' collapsed');
            chip.style.borderColor = PILLAR_COLOR_MAP[pillar.id];
            chip.style.color = PILLAR_COLOR_MAP[pillar.id];
            chip.dataset.pillar = pillar.id;

            const label = document.createElement('span');
            label.textContent = pillar.label;
            chip.appendChild(label);

            const badge = document.createElement('span');
            badge.className = 'count-badge';
            badge.textContent = (stats && stats[pillar.id]) ? stats[pillar.id] : 0;
            chip.appendChild(badge);

            chip.addEventListener('click', () => {
                togglePillarExpansion(pillar.id);
            });

            container.appendChild(chip);
        });
    }

    // General View type filter state
    const GENERAL_VIEW_CATEGORIES = [
        { id: 'parts', label: 'Parts', keywords: ['part'], color: '#4EC9B0' },
        { id: 'attributes', label: 'Attributes', keywords: ['attribute', 'attr'], color: '#9CDCFE' },
        { id: 'ports', label: 'Ports', keywords: ['port'], color: '#C586C0' },
        { id: 'actions', label: 'Actions', keywords: ['action'], color: '#DCDCAA' },
        { id: 'states', label: 'States', keywords: ['state'], color: '#CE9178' },
        { id: 'requirements', label: 'Requirements', keywords: ['requirement', 'req'], color: '#B5CEA8' },
        { id: 'interfaces', label: 'Interfaces', keywords: ['interface'], color: '#D7BA7D' },
        { id: 'usecases', label: 'Use Cases', keywords: ['use case', 'usecase'], color: '#569CD6' },
        { id: 'concerns', label: 'Concerns', keywords: ['concern', 'viewpoint', 'stakeholder', 'frame'], color: '#E5C07B' },
        { id: 'items', label: 'Items', keywords: ['item'], color: '#6A9955' },
        { id: 'other', label: 'Other', keywords: [], color: '#808080' }
    ];
    const expandedGeneralCategories = new Set(GENERAL_VIEW_CATEGORIES.map(c => c.id));

    function renderGeneralChips(typeStats) {
        const container = document.getElementById('general-chips');
        if (!container) return;
        container.innerHTML = '';

        GENERAL_VIEW_CATEGORIES.forEach(cat => {
            const count = typeStats && typeStats[cat.id] ? typeStats[cat.id] : 0;
            if (count === 0 && cat.id !== 'other') return; // Skip empty categories except 'other'

            const chip = document.createElement('button');
            chip.className = 'pillar-chip' + (expandedGeneralCategories.has(cat.id) ? '' : ' collapsed');
            chip.style.borderColor = cat.color;
            chip.style.color = cat.color;
            chip.dataset.category = cat.id;

            const label = document.createElement('span');
            label.textContent = cat.label;
            chip.appendChild(label);

            const badge = document.createElement('span');
            badge.className = 'count-badge';
            badge.textContent = count;
            chip.appendChild(badge);

            chip.addEventListener('click', () => {
                if (expandedGeneralCategories.has(cat.id)) {
                    expandedGeneralCategories.delete(cat.id);
                } else {
                    expandedGeneralCategories.add(cat.id);
                }
                renderGeneralChips(typeStats);
                // Re-render with filter applied
                renderVisualization('general-view');
            });

            container.appendChild(chip);
        });
    }

    function getCategoryForType(typeLower) {
        for (const cat of GENERAL_VIEW_CATEGORIES) {
            if (cat.keywords.some(kw => typeLower.includes(kw))) {
                return cat.id;
            }
        }
        return 'other';
    }

    function togglePillarExpansion(pillarId) {
        if (expandedPillars.has(pillarId)) {
            expandedPillars.delete(pillarId);
        } else {
            expandedPillars.add(pillarId);
        }
        updatePillarVisibility();
        renderPillarChips(lastPillarStats);
    }

    function updatePillarVisibility() {
        if (!cy) {
            return;
        }
        cy.batch(() => {
            // In orthogonal/relationships mode, we still respect pillar expansion
            // but show relationship edges between any visible nodes
            const isOrthogonalMode = sysmlMode === 'relationships';

            // Hide/show pillar nodes based on whether they are expanded
            cy.nodes('[type = "pillar"]').forEach(node => {
                const pillarId = node.data('pillar');
                const show = expandedPillars.has(pillarId);
                node.style('display', show ? 'element' : 'none');
            });

            // Hide/show element nodes based on whether their pillar is expanded
            cy.nodes('[type = "element"]').forEach(node => {
                const show = expandedPillars.has(node.data('pillar'));
                node.style('display', show ? 'element' : 'none');
            });

            // Membership edges removed - pillar containers are now hidden

            // Hide/show relationship and hierarchy edges based on source and target visibility
            const relationshipEdges = cy.edges('[type = "relationship"]');

            cy.edges('[type = "relationship"], [type = "hierarchy"]').forEach(edge => {
                const sourceVisible = edge.source().style('display') !== 'none';
                const targetVisible = edge.target().style('display') !== 'none';
                const show = sourceVisible && targetVisible;
                edge.style('display', show ? 'element' : 'none');
            });
        });
    }

    function getPillarForElement(element) {
        if (element && element.pillar) {
            return element.pillar;
        }
        const type = (element.type || '').toLowerCase();
        for (const pillar of SYSML_PILLARS) {
            if (pillar.keywords.some(keyword => type.includes(keyword))) {
                return pillar.id;
            }
        }
        if (element.type && element.type.toLowerCase().includes('require')) {
            return 'requirement';
        }
        if (element.type && element.type.toLowerCase().includes('use')) {
            return 'usecases';
        }
        return 'structure';
    }

    function propagatePillarAssignments(elements, parentPillar = null) {
        if (!elements) {
            return;
        }

        elements.forEach(element => {
            if (!element) {
                return;
            }

            const inferred = (element.type ? getPillarForElement({
                type: element.type
            }) : 'structure');
            const effective = inferred !== 'structure'
                ? inferred
                : (parentPillar || inferred);

            element.pillar = effective || 'structure';

            if (element.children && element.children.length > 0) {
                propagatePillarAssignments(element.children, element.pillar);
            }
        });
    }

    // slugify imported from ./helpers

    function resolveElementIdByName(name) {
        if (!name) {
            return null;
        }
        const key = name.toLowerCase();
        const matches = sysmlElementLookup.get(key);
        if (matches && matches.length > 0) {
            return matches[0];
        }
        for (const [stored, ids] of sysmlElementLookup.entries()) {
            if (stored === key && ids.length > 0) {
                return ids[0];
            }
        }
        return null;
    }

    function buildSysMLGraph(elements, relationships = [], useHierarchicalNesting = false) {
        sysmlElementLookup.clear();
        const cyElements = [];
        const stats = {};

        propagatePillarAssignments(elements || []);

        SYSML_PILLARS.forEach(pillar => {
            stats[pillar.id] = 0;
            cyElements.push({
                group: 'nodes',
                data: {
                    id: 'pillar-' + pillar.id,
                    label: pillar.label,
                    type: 'pillar',
                    pillar: pillar.id,
                    color: PILLAR_COLOR_MAP[pillar.id]
                }
            });
        });

        // Use hierarchical nesting for hierarchy mode
        if (useHierarchicalNesting) {
            buildHierarchicalNodes(elements || [], null, cyElements, stats, null);
        } else {
            // Flatten everything for other modes
            const flattened = flattenElements(elements || [], []);
            flattened.forEach((element, index) => {
                const pillarId = element.pillar || getPillarForElement(element);
                stats[pillarId] = (stats[pillarId] || 0) + 1;
                const nodeId = 'element-' + pillarId + '-' + slugify(element.name) + '-' + stats[pillarId];
                const lookupKey = element.name ? element.name.toLowerCase() : nodeId;
                const existing = sysmlElementLookup.get(lookupKey) || [];
                existing.push(nodeId);
                sysmlElementLookup.set(lookupKey, existing);
                // Use enhanced label that shows attributes and ports
                const baseLabel = buildEnhancedElementLabel(element);

                // Extract metadata from element
                const metadata = {
                    documentation: null,
                    properties: {}
                };

                // Get documentation from doc/comment children or the element itself
                metadata.documentation = extractDocumentation(element);

                // Get other properties from attributes
                if (element.attributes) {
                    if (element.attributes instanceof Map) {
                        // Convert Map to plain object for properties
                        element.attributes.forEach(function(value, key) {
                            if (key !== 'documentation') {
                                metadata.properties[key] = value;
                            }
                        });
                    } else if (typeof element.attributes === 'object') {
                        // Copy other properties from plain object
                        Object.entries(element.attributes).forEach(function(entry) {
                            const key = entry[0];
                            const value = entry[1];
                            if (key !== 'documentation') {
                                metadata.properties[key] = value;
                            }
                        });
                    }
                }

                // Also add properties from element.properties if available
                if (element.properties) {
                    Object.entries(element.properties).forEach(function(entry) {
                        const key = entry[0];
                        const value = entry[1];
                        if (key !== 'documentation') {
                            metadata.properties[key] = value;
                        }
                    });
                }

                cyElements.push({
                    group: 'nodes',
                    data: {
                        id: nodeId,
                        label: baseLabel,
                        baseLabel: baseLabel,
                        type: 'element',
                        pillar: pillarId,
                        color: PILLAR_COLOR_MAP[pillarId],
                        sysmlType: element.type,
                        elementName: element.name,
                        metadata: metadata
                    }
                });

                // Membership edges removed - pillar containers are now hidden
            });
        }

        // Create hierarchy edges - in hierarchy mode for visual nesting,
        // in orthogonal mode to show structural relationships
        const hierarchyLinks = createLinksFromHierarchy(elements || []);
        const hierarchyEdgeIds = new Set();

        // Build a set of valid node IDs for quick lookup
        const validNodeIds = new Set();
        cyElements.forEach(el => {
            if (el.group === 'nodes') {
                validNodeIds.add(el.data.id);
            }
        });

        hierarchyLinks.forEach(link => {
            const sourceId = resolveElementIdByName(link.source);
            const targetId = resolveElementIdByName(link.target);

            // Only create edge if both nodes exist in the graph and are different
            if (sourceId && targetId && sourceId !== targetId &&
                validNodeIds.has(sourceId) && validNodeIds.has(targetId)) {
                const edgeId = 'hier-' + sourceId + '-' + targetId;
                if (!hierarchyEdgeIds.has(edgeId)) {
                    hierarchyEdgeIds.add(edgeId);
                    cyElements.push({
                        group: 'edges',
                        data: {
                            id: edgeId,
                            source: sourceId,
                            target: targetId,
                            type: 'hierarchy',
                            label: ''
                        }
                    });
                }
            }
        });

        const relationshipEdgeIds = new Set();
        (relationships || []).forEach(rel => {
            const sourceId = resolveElementIdByName(rel.source);
            const targetId = resolveElementIdByName(rel.target);

            // Validate that both nodes exist and are different
            if (!sourceId || !targetId || sourceId === targetId ||
                !validNodeIds.has(sourceId) || !validNodeIds.has(targetId)) {
                return;
            }

            const edgeId = 'rel-' + slugify(rel.type || 'rel') + '-' + slugify(rel.source) + '-' + slugify(rel.target);
            if (relationshipEdgeIds.has(edgeId)) {
                return;
            }
            relationshipEdgeIds.add(edgeId);

            // Build a readable label:
            //  - Use rel.name when explicitly provided
            //  - For 'typing' relationships show SysML notation ": Target"
            //  - Otherwise prettify the relationship type
            let edgeLabel = rel.name || '';
            if (!edgeLabel) {
                if (rel.type === 'typing') {
                    edgeLabel = ': ' + rel.target;
                } else {
                    edgeLabel = rel.type;
                }
            }

            cyElements.push({
                group: 'edges',
                data: {
                    id: edgeId,
                    source: sourceId,
                    target: targetId,
                    type: 'relationship',
                    relType: rel.type || 'relationship',
                    label: edgeLabel
                }
            });
        });

        return { elements: cyElements, stats: stats };
    }

    // Helper function to get computed CSS variable values
    function getCSSVariable(varName) {
        return getComputedStyle(document.documentElement).getPropertyValue(varName).trim() || '#cccccc';
    }

    function getSysMLStyles() {
        // Resolve CSS variables to actual colors
        const editorFg = getCSSVariable('--vscode-editor-foreground');
        const editorBg = getCSSVariable('--vscode-editor-background');
        const chartOrange = getCSSVariable('--vscode-charts-orange');
        const chartBlue = getCSSVariable('--vscode-charts-blue');
        const chartRed = getCSSVariable('--vscode-charts-red');
        const panelBorder = getCSSVariable('--vscode-panel-border');

        return [
            {
                selector: 'node',
                style: {
                    'label': 'data(label)',
                    'color': editorFg,
                    'text-valign': 'center',
                    'text-halign': 'center',
                    'font-size': 12,
                    'font-weight': 600,
                    'background-color': editorBg,
                    'border-width': 2,
                    'border-color': 'rgba(255,255,255,0.08)',
                    'padding': '20px',
                    'shape': 'round-rectangle',
                    'text-wrap': 'wrap',
                    'text-max-width': 180,
                    'width': 'label',
                    'height': 'label',
                    'min-width': '100px',
                    'min-height': '60px',
                    'compound-sizing-wrt-labels': 'include',
                    'text-margin-x': '5px',
                    'text-margin-y': '5px',
                    'line-height': 1.5
                }
            },
            {
                selector: 'node[type = "pillar"]',
                style: {
                    'background-color': 'transparent',
                    'color': 'transparent',
                    'font-size': 0,
                    'font-weight': 0,
                    'width': 1,
                    'height': 1,
                    'border-color': 'transparent',
                    'border-width': 0,
                    'padding': '0px',
                    'opacity': 0,
                    'visibility': 'hidden'
                }
            },
            {
                selector: 'node[type = "element"]',
                style: {
                    'background-color': 'rgba(255,255,255,0.02)',
                    'border-color': 'data(color)',
                    'border-width': 2,
                    'color': editorFg,
                    'font-size': 11,
                    'text-wrap': 'wrap',
                    'text-max-width': 200,
                    'text-justification': 'left',
                    'text-halign': 'center',
                    'text-valign': 'center',
                    'padding': '18px',
                    'width': 'label',
                    'height': 'label',
                    'min-width': '120px',
                    'min-height': '60px',
                    'line-height': 1.5
                }
            },
            {
                selector: '$node > node',
                style: {
                    'padding-top': '35px',
                    'padding-left': '10px',
                    'padding-bottom': '10px',
                    'padding-right': '10px',
                    'text-valign': 'top',
                    'text-halign': 'center',
                    'text-margin-y': '12px',
                    'background-color': 'rgba(255,255,255,0.01)',
                    'border-width': 2,
                    'border-style': 'dashed',
                    'border-color': 'rgba(255,255,255,0.15)',
                    'line-height': 1.5
                }
            },
            {
                selector: 'node:parent',
                style: {
                    'background-opacity': 0.2,
                    'background-color': 'data(color)',
                    'border-color': 'data(color)',
                    'border-width': 2,
                    'border-style': 'solid',
                    'font-weight': 700,
                    'compound-sizing-wrt-labels': 'include',
                    'min-width': '140px',
                    'min-height': '90px',
                    'line-height': 1.5
                }
            },
            {
                selector: 'node.sequential-node',
                style: {
                    'background-color': 'rgba(255, 214, 153, 0.12)',
                    'border-color': chartOrange,
                    'border-width': 3
                }
            },
            {
                selector: '.highlighted-sysml',
                style: {
                    'border-color': '#FFD700',
                    'border-width': 4
                }
            },
            {
                selector: 'edge',
                style: {
                    'width': 2,
                    'line-color': panelBorder,
                    'target-arrow-color': panelBorder,
                    'curve-style': 'taxi',
                    'taxi-direction': 'rightward',
                    'taxi-turn': '20px',
                    'arrow-scale': 1,
                    'color': editorFg,
                    'font-size': 9,
                    'text-rotation': 'autorotate',
                    'text-margin-x': 6,
                    'text-margin-y': -8
                }
            },
            {
                selector: 'edge[?label]',
                style: {
                    'label': 'data(label)'
                }
            },
            // --- Per-relationship-type styles (SysML v2 notation) ---
            {
                selector: 'edge[type = "relationship"]',
                style: {
                    'line-color': chartBlue,
                    'target-arrow-color': chartBlue,
                    'width': 2,
                    'line-style': 'solid'
                }
            },
            {
                selector: 'edge[relType = "typing"]',
                style: {
                    'line-color': '#569CD6',
                    'target-arrow-color': '#569CD6',
                    'line-style': 'dashed',
                    'width': 2,
                    'target-arrow-shape': 'triangle',
                    'arrow-scale': 1
                }
            },
            {
                selector: 'edge[relType = "specializes"]',
                style: {
                    'line-color': '#C586C0',
                    'target-arrow-color': '#C586C0',
                    'line-style': 'solid',
                    'width': 2,
                    'target-arrow-shape': 'triangle-backcurve',
                    'arrow-scale': 1.2
                }
            },
            {
                selector: 'edge[relType = "containment"]',
                style: {
                    'line-color': '#4EC9B0',
                    'target-arrow-color': '#4EC9B0',
                    'line-style': 'solid',
                    'width': 2,
                    'source-arrow-shape': 'diamond',
                    'source-arrow-color': '#4EC9B0',
                    'source-arrow-fill': 'filled',
                    'arrow-scale': 1
                }
            },
            {
                selector: 'edge[relType = "connect"]',
                style: {
                    'line-color': '#D7BA7D',
                    'target-arrow-color': '#D7BA7D',
                    'line-style': 'solid',
                    'width': 2.5,
                    'target-arrow-shape': 'none'
                }
            },
            {
                selector: 'edge[relType = "interface"]',
                style: {
                    'line-color': '#D7BA7D',
                    'target-arrow-color': '#D7BA7D',
                    'line-style': 'solid',
                    'width': 2.5,
                    'target-arrow-shape': 'circle',
                    'arrow-scale': 0.8
                }
            },
            {
                selector: 'edge[relType = "flow"]',
                style: {
                    'line-color': '#4EC9B0',
                    'target-arrow-color': '#4EC9B0',
                    'line-style': 'solid',
                    'width': 2.5,
                    'target-arrow-shape': 'triangle',
                    'arrow-scale': 1.2
                }
            },
            {
                selector: 'edge[relType = "binding"]',
                style: {
                    'line-color': '#808080',
                    'target-arrow-color': '#808080',
                    'line-style': 'dashed',
                    'width': 1.5,
                    'target-arrow-shape': 'none'
                }
            },
            {
                selector: 'edge[relType = "allocation"]',
                style: {
                    'line-color': '#B5CEA8',
                    'target-arrow-color': '#B5CEA8',
                    'line-style': 'dashed',
                    'width': 2,
                    'target-arrow-shape': 'triangle',
                    'arrow-scale': 1
                }
            },
            {
                selector: 'edge[relType = "dependency"]',
                style: {
                    'line-color': '#D4D4D4',
                    'target-arrow-color': '#D4D4D4',
                    'line-style': 'dashed',
                    'width': 1.5,
                    'target-arrow-shape': 'triangle',
                    'arrow-scale': 1
                }
            },
            {
                selector: 'edge[type = "hierarchy"]',
                style: {
                    'line-color': '#6A9955',
                    'target-arrow-color': '#6A9955',
                    'target-arrow-shape': 'triangle',
                    'line-style': 'dotted',
                    'width': 1.5,
                    'arrow-scale': 1,
                    'opacity': 0.6
                }
            },

            {
                selector: 'edge[type = "sequence-guide"]',
                style: {
                    'line-color': 'transparent',
                    'target-arrow-color': 'transparent',
                    'opacity': 0,
                    'width': 0.5,
                    'arrow-scale': 0.1,
                    'curve-style': 'straight'
                }
            },
            {
                selector: 'edge[type = "sequence-order"]',
                style: {
                    'line-color': chartOrange,
                    'target-arrow-color': chartOrange,
                    'width': 3,
                    'line-style': 'dashed',
                    'target-arrow-shape': 'triangle',
                    'arrow-scale': 1.2,
                    'curve-style': 'straight',
                    'label': ''
                }
            }
        ];
    }

    function getVisibleElementNodes() {
        if (!cy) {
            return [];
        }
        return cy.nodes('node[type = "element"]').filter(node => node.style('display') !== 'none');
    }

    function isSequentialCandidateNode(node) {
        if (!node) {
            return false;
        }
        const type = (node.data('sysmlType') || '').toLowerCase();
        const label = (node.data('label') || '').toLowerCase();
        return type.includes('action') ||
            type.includes('behavior') ||
            type.includes('activity') ||
            type.includes('state') ||
            label.includes('step') ||
            label.includes('sequence');
    }

    function isSequentialBehaviorContext() {
        if (!cy) {
            return false;
        }
        const visibleNodes = getVisibleElementNodes();
        if (visibleNodes.length === 0) {
            return false;
        }
        const behaviorNodes = visibleNodes.filter(node => node.data('pillar') === 'behavior');
        if (behaviorNodes.length === 0) {
            return false;
        }
        const sequentialNodes = behaviorNodes.filter(isSequentialCandidateNode);
        if (sequentialNodes.length === 0) {
            return false;
        }
        const behaviorRatio = behaviorNodes.length / visibleNodes.length;
        return behaviorRatio >= 0.6 || behaviorNodes.length === visibleNodes.length;
    }

    function clearSequentialVisuals() {
        if (!cy) {
            return;
        }
        cy.batch(() => {
            cy.edges('[type = "sequence-order"]').remove();
            cy.nodes('.sequential-node').forEach(node => {
                node.removeClass('sequential-node');
                node.data('sequenceIndex', null);
            });
        });
    }

    function clearSequentialGuides() {
        if (!cy) {
            return;
        }
        cy.edges('[type = "sequence-guide"]').remove();
    }

    function getSequentialNodes() {
        if (!cy) {
            return [];
        }
        return getVisibleElementNodes()
            .filter(node => node.data('pillar') === 'behavior')
            .filter(isSequentialCandidateNode)
            .sort((a, b) => {
                const orderA = typeof a.data('orderIndex') === 'number'
                    ? a.data('orderIndex')
                    : Number.MAX_SAFE_INTEGER;
                const orderB = typeof b.data('orderIndex') === 'number'
                    ? b.data('orderIndex')
                    : Number.MAX_SAFE_INTEGER;
                return orderA - orderB;
            });
    }

    function createSequentialGuides(nodes) {
        if (!cy || !nodes || nodes.length < 2) {
            return;
        }
        cy.batch(() => {
            for (let i = 0; i < nodes.length - 1; i++) {
                const current = nodes[i];
                const next = nodes[i + 1];
                cy.add({
                    group: 'edges',
                    data: {
                        id: 'sequence-guide-' + current.id() + '-' + next.id(),
                        source: current.id(),
                        target: next.id(),
                        type: 'sequence-guide'
                    }
                });
            }
        });
    }

    function applySequentialVisuals(nodes) {
        if (!cy || !nodes || nodes.length === 0) {
            return;
        }
        cy.batch(() => {
            nodes.forEach((node, index) => {
                const order = index + 1;
                // Don't modify labels with numbering - just mark as sequential
                node.data('sequenceIndex', order);
                node.addClass('sequential-node');

                if (index < nodes.length - 1) {
                    const nextNode = nodes[index + 1];
                    cy.add({
                        group: 'edges',
                        data: {
                            id: 'sequence-order-' + node.id() + '-' + nextNode.id(),
                            source: node.id(),
                            target: nextNode.id(),
                            type: 'sequence-order'
                        }
                    });
                }
            });
        });
    }

    function updateSequentialOrdering(applyVisuals, sequentialContextOverride = null) {
        if (!cy) {
            return;
        }

        const sequentialContext = typeof sequentialContextOverride === 'boolean'
            ? sequentialContextOverride
            : isSequentialBehaviorContext();

        clearSequentialVisuals();
        clearSequentialGuides();

        if (!sequentialContext) {
            return;
        }

        const sequentialNodes = getSequentialNodes();
        if (!sequentialNodes || sequentialNodes.length === 0) {
            return;
        }

        if (sequentialNodes.length >= 2) {
            createSequentialGuides(sequentialNodes);
        }

        if (applyVisuals) {
            applySequentialVisuals(sequentialNodes);
        }
    }

    function getSysMLSelectionCollection() {
        if (!cy) {
            return null;
        }

        let collection = cy.elements('.highlighted-sysml');
        if (!collection || collection.length === 0) {
            collection = cy.$(':selected');
        }

        if (!collection || collection.length === 0) {
            return null;
        }

        const neighborhood = collection.closedNeighborhood();
        return neighborhood.length > 0 ? neighborhood : collection;
    }

    function fitSysMLView(padding = 80, options = {}) {
        if (!cy) {
            return;
        }

        const { preferSelection = true } = options;
        if (preferSelection) {
            const selection = getSysMLSelectionCollection();
            if (selection && selection.length > 0) {
                cy.fit(selection, padding);
                return;
            }
        }

        const visibleNodes = getVisibleElementNodes();
        let collection = visibleNodes;
        if (collection.length === 0) {
            collection = cy.nodes('node[type = "pillar"]');
        } else {
            const visibleEdges = cy.edges().filter(edge => edge.style('display') !== 'none');
            collection = collection.union(visibleEdges);
        }

        if (collection.length === 0) {
            collection = cy.elements();
        }

        cy.fit(collection, padding);
    }

    function centerOnNode(node, padding = 120) {
        if (!cy || !node || node.length === 0) {
            return;
        }
        cy.animate({
            fit: {
                eles: node,
                padding
            }
        }, {
            duration: 500,
            easing: 'ease-in-out'
        });
    }

    function runSysMLLayout(fit = false) {
        if (!cy) {
            return;
        }

        const sequentialContext = isSequentialBehaviorContext();
        updateSequentialOrdering(false, sequentialContext);

        const wantsLinearOrientation = pillarOrientation === 'linear';
        // Use DOWN for linear/default, RIGHT only for explicit horizontal mode
        const elkDirection = pillarOrientation === 'horizontal' ? 'RIGHT' : 'DOWN';

        // Increase spacing when metadata is shown to prevent overlaps
        const spacingMultiplier = showMetadata ? 2.5 : 1.0;

        let layoutOptions;
        if (sequentialContext) {
            layoutOptions = {
                name: 'elk',
                nodeDimensionsIncludeLabels: true,
                elk: {
                    algorithm: 'layered',
                    direction: 'DOWN',
                    'elk.spacing.nodeNode': String(150 * spacingMultiplier),
                    'elk.layered.spacing.nodeNodeBetweenLayers': String(180 * spacingMultiplier),
                    'elk.spacing.edgeNode': String(90 * spacingMultiplier),
                    'elk.spacing.edgeEdge': String(80 * spacingMultiplier),
                    'elk.edgeRouting': 'POLYLINE',
                    'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
                    'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
                    'elk.aspectRatio': '1.2',
                    'elk.padding': '[top=100,left=100,bottom=100,right=100]'
                },
                fit: fit,
                padding: 100,
                animate: true
            };
        } else if (sysmlMode === 'hierarchy') {
            if (wantsLinearOrientation) {
                layoutOptions = {
                    name: 'elk',
                    nodeDimensionsIncludeLabels: true,
                    elk: {
                        algorithm: 'layered',
                        direction: 'DOWN',
                        'elk.spacing.nodeNode': String(120 * spacingMultiplier),
                        'elk.layered.spacing.nodeNodeBetweenLayers': String(150 * spacingMultiplier),
                        'elk.spacing.edgeNode': String(80 * spacingMultiplier),
                        'elk.spacing.edgeEdge': String(70 * spacingMultiplier),
                        'elk.edgeRouting': 'POLYLINE',
                        'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
                        'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
                        'elk.aspectRatio': '1.0',
                        'elk.padding': '[top=100,left=100,bottom=100,right=100]',
                        'elk.layered.crossingMinimization.semiInteractive': 'true'
                    },
                    fit: fit,
                    padding: 100,
                    animate: true
                };
            } else {
                layoutOptions = {
                    name: 'breadthfirst',
                    directed: true,
                    padding: 100,
                    spacingFactor: 1.8 * spacingMultiplier,
                    animate: true,
                    fit: fit,
                    avoidOverlap: true,
                    nodeDimensionsIncludeLabels: true,
                    circle: false,
                    grid: false
                };
            }
        } else {
            // Orthogonal/relationships mode - use ELK with wider spacing
            layoutOptions = {
                name: 'elk',
                nodeDimensionsIncludeLabels: true,
                elk: {
                    algorithm: 'layered',
                    direction: 'DOWN',
                    'elk.spacing.nodeNode': String(160 * spacingMultiplier),
                    'elk.layered.spacing.nodeNodeBetweenLayers': String(200 * spacingMultiplier),
                    'elk.spacing.edgeNode': String(100 * spacingMultiplier),
                    'elk.spacing.edgeEdge': String(80 * spacingMultiplier),
                    'elk.edgeRouting': 'ORTHOGONAL',
                    'elk.layered.considerModelOrder.strategy': 'NONE',
                    'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
                    'elk.aspectRatio': '1.6',
                    'elk.padding': '[top=100,left=100,bottom=100,right=100]'
                },
                fit: fit,
                padding: 120,
                animate: true
            };
        }

        const layout = cy.layout(layoutOptions);
        if (sequentialContext || fit) {
            cy.one('layoutstop', () => {
                if (sequentialContext) {
                    updateSequentialOrdering(true, true);
                    const status = document.getElementById('status-text');
                    if (status) {
                        status.textContent = 'SysML Pillar View • Sequential behaviors arranged top-down';
                    }
                }
                if (fit) {
                    fitSysMLView(80);
                }
            });
        }

        layout.run();

        if (sysmlMode === 'relationships') {
            cy.edges('[type = "relationship"]').style({
                'opacity': 1.0,
                'width': 3,
                'z-index': 999
            });
            // Membership edges removed - pillar containers are now hidden
            // Make hierarchy edges visible in relationships mode to show structure
            cy.edges('[type = "hierarchy"]').style({
                'opacity': 0.6,
                'width': 2
            });
        } else {
            cy.edges('[type = "relationship"]').style({
                'opacity': 0.3,
                'width': 2.5
            });
            // Membership edges removed - pillar containers are now hidden
            cy.edges('[type = "hierarchy"]').style('opacity', 1.0);
        }
    }

    function disposeSysMLView() {
        if (cy) {
            cy.destroy();
            cy = null;
        }
    }

    function highlightElementInVisualization(elementName, skipCentering = false) {
        // Remove any existing highlights without refreshing
        clearVisualHighlights();

        // Find and highlight the element based on current view
        let targetElement = null;
        let elementData = null;
        let sysmlTarget = null;

        if (false) {  // tree view removed
            // In tree view, find by node data
            d3.selectAll('.node-group').each(function(d) {
                if (d && d.data && d.data.name === elementName) {
                    targetElement = d3.select(this);
                    elementData = d.data;
                }
            });
        } else if (currentView === 'sequence-view') {
            // In sequence view, find by diagram, participant, or message name
            d3.selectAll('.sequence-diagram text').each(function(d) {
                const textElement = d3.select(this);
                if (textElement.text() === elementName) {
                    targetElement = textElement;
                    elementData = { name: elementName, type: 'sequence element' };
                }
            });

            // Also check for participants and messages
            d3.selectAll('.sequence-participant text, .sequence-message').each(function(d) {
                const element = d3.select(this);
                if (element.text && element.text() === elementName) {
                    targetElement = element;
                    elementData = { name: elementName, type: 'sequence element' };
                }
            });
        } else if (currentView === 'general-view') {
            // In General View (Cytoscape), find nodes by data-element-name attribute
            d3.selectAll('.general-node').each(function() {
                const node = d3.select(this);
                const nodeName = node.attr('data-element-name');
                if (nodeName === elementName) {
                    targetElement = node;
                    elementData = { name: elementName, type: 'element' };
                }
            });
        } else if (currentView === 'interconnection-view') {
            // In Interconnection View (ibd), find parts by data-element-name attribute
            d3.selectAll('.ibd-part').each(function() {
                const partG = d3.select(this);
                const partName = partG.attr('data-element-name');
                if (partName === elementName) {
                    targetElement = partG;
                    elementData = { name: elementName, type: 'part' };
                }
            });
        } else if (currentView === 'sysml' && cy) {
            const nodeId = resolveElementIdByName(elementName);
            if (nodeId) {
                const node = cy.getElementById(nodeId);
                if (node && node.length > 0) {
                    sysmlTarget = node;
                    elementData = {
                        name: node.data('label'),
                        type: node.data('sysmlType') || 'element'
                    };
                }
            }
        }

        if (sysmlTarget && elementData) {
            cy.elements().removeClass('highlighted-sysml');
            sysmlTarget.addClass('highlighted-sysml');

            const statusBar = document.getElementById('status-bar');
            const statusText = document.getElementById('status-text');
            statusText.textContent = 'Selected: ' + elementData.name + ' [' + elementData.type + ']';
            statusBar.style.display = 'flex';

            // Only center if not skipping (i.e., click came from text editor, not diagram)
            if (!skipCentering) {
                centerOnNode(sysmlTarget, 80);
            }
            return;
        }

        if (targetElement && elementData) {
            // Add highlight class for styling
            targetElement.classed('highlighted-element', true);

            // Apply direct style to node-background for immediate visual feedback
            // This works for general-node, ibd-part, and node-group elements
            targetElement.select('.node-background')
                .style('stroke', '#FFD700')
                .style('stroke-width', '3px');
            // For IBD parts, the rect is a direct child
            targetElement.select('rect')
                .style('stroke', '#FFD700')
                .style('stroke-width', '3px');

            // Update status bar
            const statusBar = document.getElementById('status-bar');
            const statusText = document.getElementById('status-text');
            statusText.textContent = 'Selected: ' + elementData.name + ' [' + elementData.type + ']';
            statusBar.style.display = 'flex';

            // Only center the view if not skipping (i.e., click came from text editor, not diagram)
            if (!skipCentering) {
                const bbox = targetElement.node().getBBox();
                const centerX = bbox.x + bbox.width / 2;
                const centerY = bbox.y + bbox.height / 2;

                const transform = d3.zoomTransform(svg.node());
                const scale = Math.min(1.5, transform.k); // Don't zoom in too much
                const translateX = (svg.node().clientWidth / 2) - (centerX * scale);
                const translateY = (svg.node().clientHeight / 2) - (centerY * scale);

                svg.transition()
                    .duration(750)
                    .call(zoom.transform, d3.zoomIdentity.translate(translateX, translateY).scale(scale));
            }
        }
    }

    function clearSelection() {
        // Clear the filter input
        const filterInput = document.getElementById('element-filter');
        if (filterInput) {
            filterInput.value = '';
        }

        // Clear filtered data and re-render with all elements
        filteredData = null;
        document.getElementById('status-text').textContent = 'Ready • Use filter to search elements';

        // Re-render the current view with all data (no filter)
        if (currentView) {
            renderVisualization(currentView);
        }
    }

    function changeView(view) {
        // Clear any existing resize timeout to avoid conflicts
        clearTimeout(resizeTimeout);

        // Reset manual zoom flag so the new view auto-fits
        window.userHasManuallyZoomed = false;

        const proceedWithRender = () => {
            currentView = view;

            // Reset diagram selection when switching views
            selectedDiagramIndex = 0;

            // Notify the panel that the view has changed
            vscode.postMessage({
                command: 'viewChanged',
                view: view
            });

            // Update button highlighting to show active view
            updateActiveViewButton(view);

            // Show/hide activity debug button based on view
            updateActivityDebugButtonVisibility(view);

            // Small delay to allow UI to update before rendering
            setTimeout(() => {
                renderVisualization(view);
            }, 50);

            lastView = view;
        };

        if (shouldAnimateStructuralTransition(view)) {
            animateStructuralTransition(proceedWithRender);
        } else {
            proceedWithRender();
        }
    }

    function shouldAnimateStructuralTransition(nextView) {
        return STRUCTURAL_VIEWS.has(lastView) &&
            STRUCTURAL_VIEWS.has(nextView) &&
            nextView !== lastView;
    }

    function animateStructuralTransition(callback) {
        const viz = document.getElementById('visualization');
        if (!viz) {
            callback();
            return;
        }

        viz.classList.add('structural-transition-active', 'fade-out');

        // Allow fade-out to complete before rendering the next view
        setTimeout(() => {
            callback();

            // Trigger fade-in on next frame so DOM has new content
            requestAnimationFrame(() => {
                viz.classList.remove('fade-out');
                viz.classList.add('fade-in');

                setTimeout(() => {
                    viz.classList.remove('fade-in', 'structural-transition-active');
                }, 350);
            });
        }, 220);
    }

    function updateActiveViewButton(activeView) {
        const pillarButton = document.getElementById('sysml-btn');
        if (pillarButton) {
            pillarButton.classList.toggle('view-btn-active', activeView === 'sysml');
        }

        // Show/hide appropriate chip containers based on active view
        const pillarChips = document.getElementById('pillar-chips');
        const generalChips = document.getElementById('general-chips');
        if (pillarChips) {
            pillarChips.style.display = activeView === 'sysml' ? 'flex' : 'none';
        }
        if (generalChips) {
            generalChips.style.display = activeView === 'general-view' ? 'flex' : 'none';
        }

        // Show/hide layout direction button for specific views
        const layoutDirBtn = document.getElementById('layout-direction-btn');
        if (layoutDirBtn) {
            const showLayoutBtn = ['state-transition-view'].includes(activeView);
            layoutDirBtn.style.display = showLayoutBtn ? 'inline-flex' : 'none';
        }

        // Show/hide category headers button for General View only
        const categoryHeadersBtn = document.getElementById('category-headers-btn');
        if (categoryHeadersBtn) {
            categoryHeadersBtn.style.display = activeView === 'general-view' ? 'inline-flex' : 'none';
            categoryHeadersBtn.textContent = showCategoryHeaders ? '☰ Grouped' : '☷ Flat';
            if (showCategoryHeaders) {
                categoryHeadersBtn.classList.add('active');
                categoryHeadersBtn.style.background = 'var(--vscode-button-background)';
                categoryHeadersBtn.style.color = 'var(--vscode-button-foreground)';
                categoryHeadersBtn.style.borderColor = 'var(--vscode-button-background)';
            } else {
                categoryHeadersBtn.classList.remove('active');
                categoryHeadersBtn.style.background = '';
                categoryHeadersBtn.style.color = '';
                categoryHeadersBtn.style.borderColor = '';
            }
        }

        const dropdownButton = document.getElementById('view-dropdown-btn');
        const dropdownConfig = VIEW_OPTIONS[activeView];
        if (dropdownButton) {
            if (dropdownConfig) {
                dropdownButton.classList.add('view-btn-active');
                dropdownButton.innerHTML = '<span style="font-size: 9px; margin-right: 2px;">▼</span><span>' + dropdownConfig.label + '</span>';
            } else {
                dropdownButton.classList.remove('view-btn-active');
                dropdownButton.innerHTML = '<span style="font-size: 9px; margin-right: 2px;">▼</span><span>Views</span>';
            }
        }

        document.querySelectorAll('.view-dropdown-item').forEach(item => {
            const isMatch = item.getAttribute('data-view') === activeView;
            item.classList.toggle('active', isMatch);
        });

        // Show/hide state layout button based on view
        updateLayoutDirectionButton(activeView);

        // Update diagram selector visibility and content based on view
        updateDiagramSelector(activeView);
    }

    // Update diagram selector for multi-diagram views
    function updateDiagramSelector(activeView) {
        const pkgDropdown = document.getElementById('pkg-dropdown');
        const pkgMenu = document.getElementById('pkg-dropdown-menu');
        const pkgLabel = document.getElementById('pkg-dropdown-label');

        if (!pkgDropdown || !pkgMenu || !currentData) {
            if (pkgDropdown) pkgDropdown.style.display = 'none';
            return;
        }

        // Determine if this view supports multiple diagrams
        let diagrams = [];
        let labelText = 'Package';

        if (activeView === 'general-view') {
            // For General View, extract top-level packages
            const elements = currentData?.elements || [];

            const packagesArray = [];
            const seenPackages = new Set();

            // Always add "All Packages" option first
            diagrams.push({ name: 'All Packages', element: null, isAll: true });

            // Find all packages recursively up to depth 3 (includes nested packages like PartsTree, ActionTree, etc.)
            function findPackages(elementList, depth = 0) {
                elementList.forEach(el => {
                    const typeLower = (el.type || '').toLowerCase();
                    if (typeLower.includes('package') && !seenPackages.has(el.name)) {
                        seenPackages.add(el.name);
                        packagesArray.push({ name: el.name, element: el });
                    }
                    // Recurse into all children to find nested packages
                    if (el.children && el.children.length > 0) {
                        findPackages(el.children, depth + 1);
                    }
                });
            }

            findPackages(elements);

            // Add packages to diagrams array
            packagesArray.forEach(pkg => {
                diagrams.push(pkg);
            });

            labelText = 'Package';
        } else if (activeView === 'action-flow-view') {
            // Get activity diagrams
            const preparedData = prepareDataForView(currentData, 'action-flow-view');
            diagrams = preparedData?.diagrams || [];
            labelText = 'Action Flow';
        } else if (activeView === 'state-transition-view') {
            // For state view, extract state machines from state elements
            const preparedData = prepareDataForView(currentData, 'state-transition-view');
            const stateElements = preparedData?.states || [];

            // Find state machine containers using recursive search (same logic as renderStateView)
            const stateMachineMap = new Map();

            function findStateMachinesForSelector(stateList) {
                stateList.forEach(s => {
                    const typeLower = (s.type || '').toLowerCase();
                    const nameLower = (s.name || '').toLowerCase();

                    // State machine containers: exhibit state, or names ending with "States"
                    const isContainer = typeLower.includes('exhibit') ||
                                       nameLower.endsWith('states') ||
                                       (typeLower.includes('state') && s.children && s.children.length > 0 &&
                                        s.children.some(c => (c.type || '').toLowerCase().includes('state')));

                    // Skip definitions
                    if (isContainer && !typeLower.includes('def')) {
                        stateMachineMap.set(s.name, s);
                    }

                    // Recurse into children
                    if (s.children && s.children.length > 0) {
                        findStateMachinesForSelector(s.children);
                    }
                });
            }

            findStateMachinesForSelector(stateElements);

            diagrams = Array.from(stateMachineMap.entries()).map(([name, element]) => ({
                name: name,
                element: element
            }));

            // If no state machines found but there are states, show "All States" as single option
            if (diagrams.length === 0 && stateElements.length > 0) {
                diagrams = [{ name: 'All States', element: null }];
            }

            labelText = 'State Machine';
        } else if (activeView === 'sequence-view') {
            // Get sequence diagrams
            diagrams = currentData?.sequenceDiagrams || [];
            labelText = 'Sequence';
        } else if (activeView === 'interconnection-view') {
            // For these views, extract top-level packages (same as elk/General View)
            const elements = currentData?.elements || [];

            const packagesArray = [];
            const seenPackages = new Set();

            // Always add "All Packages" option first
            diagrams.push({ name: 'All Packages', element: null, isAll: true });

            // Find all packages recursively up to depth 3 (SysML v2 spec allows nested packages)
            function findPackagesForView(elementList, depth = 0) {
                elementList.forEach(el => {
                    const typeLower = (el.type || '').toLowerCase();
                    if (typeLower.includes('package') && !seenPackages.has(el.name)) {
                        seenPackages.add(el.name);
                        packagesArray.push({ name: el.name, element: el });
                    }
                    // Recurse into all children to find nested packages
                    if (el.children && el.children.length > 0) {
                        findPackagesForView(el.children, depth + 1);
                    }
                });
            }

            findPackagesForView(elements);

            // Add packages to diagrams array
            packagesArray.forEach(pkg => {
                diagrams.push(pkg);
            });

            labelText = 'Package';
        }

        // Show/hide selector based on number of diagrams
        if (diagrams.length <= 1) {
            pkgDropdown.style.display = 'none';
            selectedDiagramIndex = 0;
            selectedDiagramName = diagrams.length === 1 ? diagrams[0].name : null;
            return;
        }

        pkgDropdown.style.display = 'flex';
        if (pkgLabel) pkgLabel.textContent = labelText;

        // Try to restore selection by name if we have a previously selected diagram
        if (selectedDiagramName) {
            const matchingIndex = diagrams.findIndex(d => d.name === selectedDiagramName);
            if (matchingIndex >= 0) {
                selectedDiagramIndex = matchingIndex;
                if (pkgLabel) pkgLabel.textContent = selectedDiagramName;
            } else {
                // Diagram no longer exists, reset to first
                selectedDiagramIndex = 0;
                selectedDiagramName = diagrams[0]?.name || null;
            }
        } else {
            // No previous selection, initialize with first diagram
            selectedDiagramName = diagrams[0]?.name || null;
        }

        // Populate dropdown menu
        pkgMenu.innerHTML = '';
        diagrams.forEach((d, idx) => {
            const item = document.createElement('button');
            item.className = 'view-dropdown-item';
            item.textContent = d.name || 'Diagram ' + (idx + 1);
            if (idx === selectedDiagramIndex) item.classList.add('active');
            item.addEventListener('click', function() {
                selectedDiagramIndex = idx;
                selectedDiagramName = d.name;
                // Update active state
                pkgMenu.querySelectorAll('.view-dropdown-item').forEach(i => i.classList.remove('active'));
                item.classList.add('active');
                // Update label
                if (pkgLabel) pkgLabel.textContent = d.name;
                // Close menu
                pkgMenu.classList.remove('show');
                // Re-render
                renderVisualization(currentView);
            });
            pkgMenu.appendChild(item);
        });

        // Ensure selected index is valid
        if (selectedDiagramIndex >= diagrams.length) {
            selectedDiagramIndex = 0;
            selectedDiagramName = diagrams[0]?.name || null;
        }
    }

    // Universal layout direction labels and icons
    const LAYOUT_DIRECTION_LABELS = {
        'horizontal': 'Left → Right',
        'vertical': 'Top → Down',
        'auto': 'Auto Layout'
    };
    const LAYOUT_DIRECTION_ICONS = {
        'horizontal': '→',
        'vertical': '↓',
        'auto': '◎'
    };

    function updateLayoutDirectionButton(activeView) {
        const layoutBtn = document.getElementById('layout-direction-btn');
        if (layoutBtn) {
            // Use activity-specific direction for activity view
            const effectiveDirection = activeView === 'action-flow-view' ? activityLayoutDirection : layoutDirection;
            const icon = LAYOUT_DIRECTION_ICONS[effectiveDirection] || '→';
            const label = LAYOUT_DIRECTION_LABELS[effectiveDirection] || 'Left → Right';
            layoutBtn.textContent = icon + ' ' + label;

            // Update tooltip to show next option
            const nextMode = getNextLayoutDirection(effectiveDirection);
            const nextLabel = LAYOUT_DIRECTION_LABELS[nextMode];
            layoutBtn.title = 'Switch to ' + nextLabel;

            // Sync with view-specific orientations for backwards compatibility
            stateLayoutOrientation = layoutDirection === 'auto' ? 'force' : layoutDirection;
        }
    }

    function getNextLayoutDirection(current) {
        const modes = ['horizontal', 'vertical', 'auto'];
        const currentIndex = modes.indexOf(current);
        return modes[(currentIndex + 1) % modes.length];
    }

    function toggleLayoutDirection() {
        // Use activity-specific direction for activity view
        if (currentView === 'action-flow-view') {
            activityLayoutDirection = getNextLayoutDirection(activityLayoutDirection);
        } else {
            layoutDirection = getNextLayoutDirection(layoutDirection);
        }
        updateLayoutDirectionButton(currentView);
        // Re-render the current view
        renderVisualization(currentView);
    }

    function toggleCategoryHeaders() {
        showCategoryHeaders = !showCategoryHeaders;
        // Update button text and active styling
        const btn = document.getElementById('category-headers-btn');
        if (btn) {
            btn.textContent = showCategoryHeaders ? '☰ Grouped' : '☷ Flat';
            if (showCategoryHeaders) {
                btn.classList.add('active');
                btn.style.background = 'var(--vscode-button-background)';
                btn.style.color = 'var(--vscode-button-foreground)';
                btn.style.borderColor = 'var(--vscode-button-background)';
            } else {
                btn.classList.remove('active');
                btn.style.background = '';
                btn.style.color = '';
                btn.style.borderColor = '';
            }
        }
        // Re-render the General view
        if (currentView === 'general-view') {
            renderVisualization('general-view');
        }
    }

    function updateStateLayoutButton(activeView) {
        // Legacy function - now handled by updateLayoutDirectionButton
    }

    function updateUsecaseLayoutButton(activeView) {
        // Legacy function - now handled by updateLayoutDirectionButton
    }

    function getNextLayoutMode(current) {
        const modes = ['horizontal', 'vertical', 'force'];
        const currentIndex = modes.indexOf(current);
        return modes[(currentIndex + 1) % modes.length];
    }

    function toggleStateLayout() {
        layoutDirection = getNextLayoutDirection(layoutDirection);
        stateLayoutOrientation = layoutDirection === 'auto' ? 'force' : layoutDirection;
        updateLayoutDirectionButton(currentView);
        // Re-render the state view
        if (currentView === 'state-transition-view') {
            renderVisualization('state-transition-view');
        }
    }

    function toggleUsecaseLayout() {
        layoutDirection = getNextLayoutDirection(layoutDirection);
        updateLayoutDirectionButton(currentView);
        // Re-render the usecase view
        if (false) {  // usecase view removed
        }
    }

    // Make functions globally accessible for HTML onclick handlers
    window.changeView = changeView;

    function renderVisualization(view, preserveZoomOverride = null, allowDuringResize = false) {
        if (!currentData) {
            return;
        }

        if (isRendering) {
            // Already rendering, skip
            return;
        }

        // Only reset manual zoom flag when the view type actually changes
        // This preserves zoom state when the same view is re-rendered due to data changes
        const viewChanged = view !== lastView;
        if (viewChanged) {
            window.userHasManuallyZoomed = false;
        }

        // Use filtered data if available, otherwise use original data
        let baseData = filteredData || currentData;

        // Apply package filter for views that support it (excluding elk which handles it internally)
        // Index 0 = "All Packages", Index 1+ = specific packages
        if (selectedDiagramIndex > 0 &&
            (view === 'interconnection-view')) {

            const elements = baseData?.elements || [];
            const packagesArray = [];
            const seenPackages = new Set();

            // Find all packages recursively (SysML v2 spec allows nested packages up to depth 3)
            function findPackagesForRender(elementList, depth = 0) {
                elementList.forEach(el => {
                    const typeLower = (el.type || '').toLowerCase();
                    if (typeLower.includes('package') && depth <= 3 && !seenPackages.has(el.name)) {
                        seenPackages.add(el.name);
                        packagesArray.push({ name: el.name, element: el });
                    }
                    // Recurse into all children to find nested packages
                    if (el.children && el.children.length > 0) {
                        findPackagesForRender(el.children, depth + 1);
                    }
                });
            }

            findPackagesForRender(elements);

            // Get the selected package (index 0 is "All Packages", so subtract 1)
            const selectedPackageIdx = selectedDiagramIndex - 1;
            if (selectedPackageIdx >= 0 && selectedPackageIdx < packagesArray.length) {
                const selectedPackage = packagesArray[selectedPackageIdx];

                // Create filtered baseData with only this package's contents
                if (selectedPackage.element) {
                    baseData = {
                        ...baseData,
                        elements: [selectedPackage.element]
                    };
                }
            }
        }

        const dataToRender = prepareDataForView(baseData, view);

        isRendering = true;

        // Show loading indicator
        showLoading('Rendering ' + (VIEW_OPTIONS[view]?.label || view) + '...');

        // Safety timeout: auto-reset isRendering after 10 seconds to prevent permanent lockup
        const renderSafetyTimeout = setTimeout(() => {
            if (isRendering) {
                isRendering = false;
            }
        }, 10000);

        // Test basic setup
        const vizElement = document.getElementById('visualization');

        // Add error handling around rendering
        try {

        // Preserve current zoom state before clearing
        let currentTransform = d3.zoomIdentity;
        let shouldPreserveZoom = false;

        if (svg && zoom) {
            try {
                currentTransform = d3.zoomTransform(svg.node());
                // Only preserve zoom if user has manually interacted
                shouldPreserveZoom = window.userHasManuallyZoomed === true;
            } catch (e) {
                // If there's an error getting transform, don't preserve
                shouldPreserveZoom = false;
                currentTransform = d3.zoomIdentity;
            }
        }

        d3.select('#visualization').selectAll('*').remove();

        const width = document.getElementById('visualization').clientWidth;
        const height = document.getElementById('visualization').clientHeight;

        function buildElkContext() {
            return {
                elkWorkerUrl,
                getCy: () => cy,
                setCy: (c) => { cy = c; },
                getSvg: () => svg,
                getG: () => g,
                buildSysMLGraph,
                setSysMLToolbarVisible,
                renderPillarChips,
                setLastPillarStats: (stats) => { lastPillarStats = stats; },
                getSysMLStyles,
                runSysMLLayout,
                updatePillarVisibility,
                togglePillarExpansion,
                centerOnNode,
                isSequentialBehaviorContext,
                updateMinimap,
                postMessage: (msg) => vscode.postMessage(msg),
                SYSML_PILLARS,
                PILLAR_COLOR_MAP,
                sysmlMode,
                getCategoryForType,
                expandedGeneralCategories,
                GENERAL_VIEW_CATEGORIES,
                renderGeneralChips,
                reRenderElk: () => renderVisualization('general-view'),
                showCategoryHeaders,
                selectedDiagramIndex,
                currentData,
                clearVisualHighlights,
                renderPlaceholder: (wd, ht, viewName, message, d) => renderPlaceholderView(wd, ht, viewName, message, d),
                isLibraryValidated,
                getLibraryKind,
                getLibraryChain,
                onStartInlineEdit: (nodeG, elementName, x, y, wd) => startInlineEdit(nodeG, elementName, x, y, wd)
            };
        }

        // SysML Pillar view uses Cytoscape - bypass SVG/D3 setup
        if (view === 'sysml') {
            renderSysMLViewModule(buildElkContext(), width, height, dataToRender);
            lastView = view;
            setTimeout(() => {
                isRendering = false;
                hideLoading();
            }, 100);
            return;
        }

        svg = d3.select('#visualization')
            .append('svg')
            .attr('width', width)
            .attr('height', height);

        zoom = d3.zoom()
            .scaleExtent([MIN_CANVAS_ZOOM, MAX_CANVAS_ZOOM])
            .on('zoom', (event) => {
                g.attr('transform', event.transform);
                // Update minimap viewport when zooming/panning
                updateMinimap();
                // Mark as manual interaction if triggered by user (not programmatic)
                if (event.sourceEvent) {
                    window.userHasManuallyZoomed = true;
                }
            });

        // Enable mouse-centered zooming by setting the zoom center
        svg.call(zoom)
            .on('dblclick.zoom', null) // Disable default double-click zoom behavior
            .on('wheel.zoom', function(event) {
                event.preventDefault();

                // Mark that user has manually zoomed
                window.userHasManuallyZoomed = true;

                // Get mouse position relative to SVG
                const mouse = d3.pointer(event, this);
                const currentTransform = d3.zoomTransform(this);

                // Calculate zoom factor - larger values for faster zooming
                const factor = event.deltaY > 0 ? 0.75 : 1.33;
                const newScale = Math.min(
                    Math.max(currentTransform.k * factor, MIN_CANVAS_ZOOM),
                    MAX_CANVAS_ZOOM
                );

                // Calculate new translation to zoom around mouse position
                const translateX = mouse[0] - (mouse[0] - currentTransform.x) * (newScale / currentTransform.k);
                const translateY = mouse[1] - (mouse[1] - currentTransform.y) * (newScale / currentTransform.k);

                // Apply the transform
                d3.select(this)
                    .transition()
                    .duration(50)
                    .call(zoom.transform, d3.zoomIdentity.translate(translateX, translateY).scale(newScale));
            });
        g = svg.append('g');

        // Restore the zoom state after creating new elements, but do it after render
        const restoreZoom = () => {
            if (shouldPreserveZoom && currentTransform) {
                // Use a slight delay to ensure elements are rendered
                setTimeout(() => {
                    svg.transition()
                        .duration(0)  // No animation for restore
                        .call(zoom.transform, currentTransform);
                }, 10);
            }
        };

        // Build context for modular renderers
        function buildRenderContext(w, h) {
            return {
                width: w,
                height: h,
                svg,
                g,
                zoom,
                getCy: () => cy,
                layoutDirection,
                activityLayoutDirection,
                activityDebugLabels,
                stateLayoutOrientation,
                selectedDiagramIndex,
                postMessage: (msg) => vscode.postMessage(msg),
                onStartInlineEdit: (nodeG, elementName, x, y, wd) => startInlineEdit(nodeG, elementName, x, y, wd),
                renderPlaceholder: (wd, ht, viewName, message, d) => renderPlaceholderView(wd, ht, viewName, message, d),
                clearVisualHighlights
            };
        }

        // Add global click handler to close expanded details when clicking on empty space
        svg.on('click', (event) => {
            // Only close if clicking on the SVG background (not on nodes or details)
            if (event.target === svg.node() || event.target === g.node()) {
                // Clear all highlights when clicking on empty space
                clearVisualHighlights();
                g.selectAll('.expanded-details').remove();
                // Reset graph view selections (clearVisualHighlights already restores node-background)
                g.selectAll('.graph-node-background').each(function() {
                    const el = d3.select(this);
                    el.style('stroke', el.attr('data-original-stroke') || 'var(--vscode-panel-border)');
                    el.style('stroke-width', el.attr('data-original-width') || '2px');
                });
                g.selectAll('.node-group').classed('selected', false);
                g.selectAll('.graph-node-group').classed('selected', false);
                g.selectAll('.hierarchy-cell').classed('selected', false);
                g.selectAll('.elk-node').classed('selected', false);

                // Clear IBD connector highlights
                g.selectAll('.ibd-connector').each(function() {
                    const el = d3.select(this);
                    const origStroke = el.attr('data-original-stroke');
                    const origWidth = el.attr('data-original-width');
                    if (origStroke) {
                        el.style('stroke', origStroke)
                          .style('stroke-width', origWidth)
                          .classed('connector-highlighted', false);
                        el.attr('data-original-stroke', null)
                          .attr('data-original-width', null);
                    }
                });

                // Clear General View connector highlights
                g.selectAll('.general-connector').each(function() {
                    const el = d3.select(this);
                    const origStroke = el.attr('data-original-stroke');
                    const origWidth = el.attr('data-original-width');
                    if (origStroke) {
                        el.style('stroke', origStroke)
                          .style('stroke-width', origWidth)
                          .classed('connector-highlighted', false);
                        el.attr('data-original-stroke', null)
                          .attr('data-original-width', null);
                    }
                });
            }
        });

        // Handle async and sync rendering
        if (view === 'general-view') {
            renderElkTreeViewModule(buildElkContext(), width, height, dataToRender).then(() => {
                // If zoom was previously modified, restore it; otherwise zoom to fit
                if (shouldPreserveZoom) {
                    restoreZoom();
                } else {
                    // Delay zoom to fit to ensure ELK layout is complete
                    setTimeout(() => zoomToFit('auto'), 200);
                }
                setTimeout(() => {
                    updateDimensionsDisplay();
                    isRendering = false; // Reset rendering flag
                    updateMinimap(); // Update minimap after rendering
                    hideLoading(); // Hide loading indicator
                }, 300);
            }).catch((error) => {
                console.error('[General View] Render error:', error);
                isRendering = false; // Reset flag on error too
                hideLoading(); // Hide loading indicator on error
            });
        } else {
            // Synchronous rendering (SysML v2 frameless-view types)
            if (view === 'sequence-view') {
                renderSequenceViewModule(buildRenderContext(width, height), dataToRender);
            } else if (view === 'interconnection-view') {
                renderIbdViewModule(buildRenderContext(width, height), dataToRender);
            } else if (view === 'action-flow-view') {
                renderActivityViewModule(buildRenderContext(width, height), dataToRender);
            } else if (view === 'state-transition-view') {
                renderStateViewModule(buildRenderContext(width, height), dataToRender);
            } else {
                renderPlaceholderView(width, height, 'Unknown View', 'The selected view is not yet implemented.', dataToRender);
            }

            // If zoom was previously modified, restore it; otherwise zoom to fit
            if (shouldPreserveZoom) {
                restoreZoom();
            } else {
                // Delay zoom to fit to ensure rendering is complete
                setTimeout(() => zoomToFit('auto'), 100);
            }

            // Show initial dimensions briefly
            setTimeout(() => {
                updateDimensionsDisplay();
                isRendering = false; // Reset rendering flag
                updateMinimap(); // Update minimap after rendering
                hideLoading(); // Hide loading indicator
            }, 200);
        }

        // Update lastView after successful render start
        lastView = view;
        } catch (error) {
            console.error('Error during rendering:', error);
            isRendering = false; // Reset flag on error
            hideLoading(); // Hide loading indicator on error

            // Show error message to user
            const statusText = document.getElementById('status-text');
            if (statusText) {
                statusText.textContent = 'Error rendering visualization: ' + error.message;
            }
        }
    }

    // Tree View Renderer - implemented in renderers/tree.ts

    function expandTreeNodeDetails(nodeData, nodeGroup) {
        // Remove any existing expanded details
        g.selectAll('.expanded-details').remove();

        // Remove selection styling from all nodes - restore original strokes
        g.selectAll('.node-background').each(function() {
            const el = d3.select(this);
            el.style('stroke', el.attr('data-original-stroke') || 'var(--vscode-panel-border)');
            el.style('stroke-width', el.attr('data-original-width') || '1px');
        });
        g.selectAll('.node-group').classed('selected', false);

        // Add selection styling to clicked node
        nodeGroup.select('.node-background')
            .style('stroke', 'var(--vscode-charts-blue)')
            .style('stroke-width', '3px');
        nodeGroup.classed('selected', true);

        // Get the node's transform to position the details panel
        const transform = nodeGroup.attr('transform');
        const matches = transform.match(/translate[(]([^,]+),([^)]+)[)]/);
        const nodeX = parseFloat(matches[1]);
        const nodeY = parseFloat(matches[2]);

        // Calculate dynamic dimensions based on content
        const baseHeight = 85; // Base height for name, type, level
        const lineHeight = 15;
        const sectionSpacing = 10;
        let contentHeight = baseHeight;

        // Calculate documentation height
        const docHeight = nodeData.data.properties?.documentation
            ? Math.min(Math.ceil(String(nodeData.data.properties.documentation).length / 35), 3) * 14 + 30 + sectionSpacing
            : 0;
        contentHeight += docHeight;

        // Calculate attributes height
        const attributes = nodeData.data.attributes || {};
        const displayableAttributes = Object.entries(attributes).filter(([key]) =>
            !key.startsWith('is') && key !== 'visibility'
        );
        const attributesHeight = displayableAttributes.length > 0
            ? Math.min(displayableAttributes.length, 4) * lineHeight + 20 + sectionSpacing
            : 0;
        contentHeight += attributesHeight;

        // Calculate properties height
        const properties = nodeData.data.properties || {};
        const regularProperties = Object.entries(properties).filter(([key]) => key !== 'documentation');
        const propertiesHeight = regularProperties.length > 0
            ? Math.min(regularProperties.length, 3) * lineHeight + 20 + sectionSpacing
            : 0;
        contentHeight += propertiesHeight;

        // Calculate children height (with attributes showing)
        let childrenHeight = 0;
        if (nodeData.children && nodeData.children.length > 0) {
            const maxChildrenToShow = Math.min(nodeData.children.length, 4);
            let childContentHeight = 20 + sectionSpacing; // Header height

            nodeData.children.slice(0, maxChildrenToShow).forEach(child => {
                childContentHeight += lineHeight; // Child name line

                // Add height for child attributes
                if (child.data.attributes && Object.keys(child.data.attributes).length > 0) {
                    const childAttrs = Object.entries(child.data.attributes).filter(([key]) =>
                        !key.startsWith('is') && key !== 'visibility'
                    );
                    childContentHeight += Math.min(childAttrs.length, 3) * 12; // 12px per attribute line
                }
                childContentHeight += 5; // Spacing between children
            });

            if (nodeData.children.length > maxChildrenToShow) {
                childContentHeight += 15; // "... more children" line
            }

            childrenHeight = childContentHeight;
        }
        contentHeight += childrenHeight;

        // Add button height and padding
        const buttonHeight = 25;
        const totalHeight = contentHeight + buttonHeight;

        // Dynamic width based on content
        const maxNameLength = Math.max(
            nodeData.data.name.length,
            nodeData.data.type.length + 6, // "Type: " prefix
            ...(displayableAttributes.slice(0, 4).map(([k, v]) => (k + ': ' + String(v)).length)),
            ...(regularProperties.slice(0, 3).map(([k, v]) => (k + ': ' + String(v)).length)),
            ...(nodeData.children ? nodeData.children.slice(0, 4).map(child => {
                const childNameLength = ('• ' + child.data.name + ' [' + child.data.type + ']').length;
                const childAttrs = child.data.attributes ? Object.entries(child.data.attributes).filter(([key]) =>
                    !key.startsWith('is') && key !== 'visibility'
                ) : [];
                const maxAttrLength = childAttrs.length > 0 ? Math.max(...childAttrs.map(([k, v]) =>
                    ('    ' + k + ': ' + String(v)).length
                )) : 0;
                return Math.max(childNameLength, maxAttrLength);
            }) : [])
        );
        const dynamicWidth = Math.max(250, Math.min(450, maxNameLength * 7 + 60));

        const popupWidth = dynamicWidth;
        const popupHeight = totalHeight;
        const buttonY = popupHeight - 20;

        // Create expanded details panel positioned next to the node
        const detailsGroup = g.append('g')
            .attr('class', 'expanded-details')
            .attr('transform', 'translate(' + (nodeX + 20) + ',' + (nodeY - 50) + ')');

        // Panel background with dynamic dimensions
        detailsGroup.append('rect')
            .attr('x', 0)
            .attr('y', 0)
            .attr('width', popupWidth)
            .attr('height', popupHeight)
            .attr('rx', 8)
            .style('fill', 'var(--vscode-editor-background)')
            .style('stroke', 'var(--vscode-charts-blue)')
            .style('stroke-width', '2px')
            .style('filter', 'drop-shadow(3px 3px 6px rgba(0,0,0,0.4))');

        // Close button - adjusted for smaller panel
        detailsGroup.append('circle')
            .attr('cx', 185)
            .attr('cy', 15)
            .attr('r', 10)
            .style('fill', 'var(--vscode-charts-red)')
            .style('cursor', 'pointer')
            .on('click', () => {
                g.selectAll('.expanded-details').remove();
                g.selectAll('.node-background')
                    .style('stroke', 'var(--vscode-panel-border)')
                    .style('stroke-width', '1px');
            });

        detailsGroup.append('text')
            .attr('x', 185)
            .attr('y', 19)
            .attr('text-anchor', 'middle')
            .text('×')
            .style('fill', 'white')
            .style('font-size', '12px')
            .style('font-weight', 'bold')
            .style('cursor', 'pointer')
            .on('click', () => {
                g.selectAll('.expanded-details').remove();
                g.selectAll('.node-background')
                    .style('stroke', 'var(--vscode-panel-border)')
                    .style('stroke-width', '1px');
            });

        // Element name
        detailsGroup.append('text')
            .attr('x', 15)
            .attr('y', 25)
            .text(nodeData.data.name)
            .style('font-weight', 'bold')
            .style('font-size', '16px')
            .style('fill', 'var(--vscode-editor-foreground)');

        // Element type
        detailsGroup.append('text')
            .attr('x', 15)
            .attr('y', 45)
            .text('Type: ' + nodeData.data.type)
            .style('font-size', '12px')
            .style('fill', 'var(--vscode-descriptionForeground)');

        let yOffset = 65;

        // Library validation status
        if (isLibraryValidated(nodeData.data)) {
            const libKind = getLibraryKind(nodeData.data);
            const libChain = getLibraryChain(nodeData.data);

            detailsGroup.append('text')
                .attr('x', 15)
                .attr('y', yOffset)
                .text('✓ Standard Library Type')
                .style('font-size', '12px')
                .style('font-weight', 'bold')
                .style('fill', 'var(--vscode-charts-green)');

            yOffset += 20;

            if (libKind) {
                detailsGroup.append('text')
                    .attr('x', 15)
                    .attr('y', yOffset)
                    .text('Library Kind: ' + libKind)
                    .style('font-size', '11px')
                    .style('fill', 'var(--vscode-descriptionForeground)');
                yOffset += 18;
            }

            if (libChain) {
                detailsGroup.append('text')
                    .attr('x', 15)
                    .attr('y', yOffset)
                    .text('Specialization: ' + libChain)
                    .style('font-size', '11px')
                    .style('fill', 'var(--vscode-descriptionForeground)');
                yOffset += 18;
            }
        }

        // Hierarchy level
        detailsGroup.append('text')
            .attr('x', 15)
            .attr('y', yOffset)
            .text('Level: ' + nodeData.depth)
            .style('font-size', '12px')
            .style('fill', 'var(--vscode-descriptionForeground)');

        yOffset += 20;

        // Documentation section
        if (nodeData.data.properties && nodeData.data.properties.documentation) {
            detailsGroup.append('text')
                .attr('x', 15)
                .attr('y', yOffset)
                .text('Documentation:')
                .style('font-weight', 'bold')
                .style('font-size', '13px')
                .style('fill', 'var(--vscode-editor-foreground)');

            yOffset += 20;
            // Wrap long documentation text
            const docText = String(nodeData.data.properties.documentation);
            const maxLineLength = 35;
            const lines = [];

            if (docText.length > maxLineLength) {
                let currentLine = '';
                const words = docText.split(' ');

                for (const word of words) {
                    if ((currentLine + word).length > maxLineLength && currentLine.length > 0) {
                        lines.push(currentLine.trim());
                        currentLine = word + ' ';
                    } else {
                        currentLine += word + ' ';
                    }
                }
                if (currentLine.trim().length > 0) {
                    lines.push(currentLine.trim());
                }
            } else {
                lines.push(docText);
            }

            // Show first 3 lines of documentation
            lines.slice(0, 3).forEach(line => {
                detailsGroup.append('text')
                    .attr('x', 25)
                    .attr('y', yOffset)
                    .text(line)
                    .style('font-size', '10px')
                    .style('fill', 'var(--vscode-descriptionForeground)')
                    .style('font-style', 'italic');
                yOffset += 14;
            });

            if (lines.length > 3) {
                detailsGroup.append('text')
                    .attr('x', 25)
                    .attr('y', yOffset)
                    .text('... (' + (lines.length - 3) + ' more lines)')
                    .style('font-size', '9px')
                    .style('fill', 'var(--vscode-descriptionForeground)');
                yOffset += 12;
            }

            yOffset += 10; // Extra spacing after documentation
        }

        // Attributes section - show SysML element attributes
        const nodeAttributes = nodeData.data.attributes || {};
        const displayAttributes = Object.entries(nodeAttributes).filter(([key]) =>
            // Filter out internal attributes that aren't useful for display
            !key.startsWith('is') && key !== 'visibility'
        );

        if (displayAttributes.length > 0) {
            detailsGroup.append('text')
                .attr('x', 15)
                .attr('y', yOffset)
                .text('Attributes:')
                .style('font-weight', 'bold')
                .style('font-size', '13px')
                .style('fill', 'var(--vscode-editor-foreground)');

            yOffset += 20;
            displayAttributes.slice(0, 4).forEach(([key, value]) => {
                detailsGroup.append('text')
                    .attr('x', 25)
                    .attr('y', yOffset)
                    .text(key + ': ' + (String(value).length > 25 ? String(value).substring(0, 22) + '...' : String(value)))
                    .style('font-size', '11px')
                    .style('fill', 'var(--vscode-charts-purple)');
                yOffset += 15;
            });

            if (displayAttributes.length > 4) {
                detailsGroup.append('text')
                    .attr('x', 25)
                    .attr('y', yOffset)
                    .text('... (' + (displayAttributes.length - 4) + ' more attributes)')
                    .style('font-size', '10px')
                    .style('font-style', 'italic')
                    .style('fill', 'var(--vscode-descriptionForeground)');
                yOffset += 15;
            }

            yOffset += 10; // Extra spacing after attributes
        }

        // Properties section (excluding documentation which is shown separately)
        const nodeProperties = nodeData.data.properties || {};
        const displayProperties = Object.entries(nodeProperties).filter(([key]) => key !== 'documentation');

        if (displayProperties.length > 0) {
            detailsGroup.append('text')
                .attr('x', 15)
                .attr('y', yOffset)
                .text('Properties:')
                .style('font-weight', 'bold')
                .style('font-size', '13px')
                .style('fill', 'var(--vscode-editor-foreground)');

            yOffset += 20;
            displayProperties.slice(0, 3).forEach(([key, value]) => {
                detailsGroup.append('text')
                    .attr('x', 25)
                    .attr('y', yOffset)
                    .text(key + ': ' + (String(value).length > 25 ? String(value).substring(0, 22) + '...' : String(value)))
                    .style('font-size', '11px')
                    .style('fill', 'var(--vscode-descriptionForeground)');
                yOffset += 15;
            });
        }

        // Children section - now shows more children with attributes
        if (nodeData.children && nodeData.children.length > 0) {
            detailsGroup.append('text')
                .attr('x', 15)
                .attr('y', yOffset)
                .text('Children (' + nodeData.children.length + '):')
                .style('font-weight', 'bold')
                .style('font-size', '13px')
                .style('fill', 'var(--vscode-editor-foreground)');

            yOffset += 20;
            const maxChildrenToShow = Math.min(nodeData.children.length, 4); // Show up to 4 children with attributes

            nodeData.children.slice(0, maxChildrenToShow).forEach(child => {
                // Child name and type
                const childText = '• ' + child.data.name + ' [' + child.data.type + ']';
                const truncatedText = childText.length > 40
                    ? childText.substring(0, 37) + '...'
                    : childText;

                detailsGroup.append('text')
                    .attr('x', 25)
                    .attr('y', yOffset)
                    .text(truncatedText)
                    .style('font-size', '11px')
                    .style('font-weight', 'bold')
                    .style('fill', 'var(--vscode-editor-foreground)');
                yOffset += 15;

                // Show child attributes if they exist
                if (child.data.attributes && Object.keys(child.data.attributes).length > 0) {
                    const childAttributes = Object.entries(child.data.attributes);
                    const maxAttrsToShow = Math.min(childAttributes.length, 3);

                    childAttributes.slice(0, maxAttrsToShow).forEach(([key, value]) => {
                        // Skip internal attributes that aren't useful for display
                        if (!key.startsWith('is') && key !== 'visibility') {
                            const attrText = '    ' + key + ': ' + String(value);
                            const truncatedAttr = attrText.length > 35
                                ? attrText.substring(0, 32) + '...'
                                : attrText;

                            detailsGroup.append('text')
                                .attr('x', 35)
                                .attr('y', yOffset)
                                .text(truncatedAttr)
                                .style('font-size', '10px')
                                .style('font-style', 'italic')
                                .style('fill', 'var(--vscode-charts-purple)');
                            yOffset += 12;
                        }
                    });

                    if (childAttributes.length > maxAttrsToShow) {
                        detailsGroup.append('text')
                            .attr('x', 35)
                            .attr('y', yOffset)
                            .text('    ... (' + (childAttributes.length - maxAttrsToShow) + ' more attrs)')
                            .style('font-size', '9px')
                            .style('font-style', 'italic')
                            .style('fill', 'var(--vscode-descriptionForeground)');
                        yOffset += 12;
                    }
                }

                yOffset += 5; // Extra spacing between children
            });

            if (nodeData.children.length > maxChildrenToShow) {
                detailsGroup.append('text')
                    .attr('x', 25)
                    .attr('y', yOffset)
                    .text('... and ' + (nodeData.children.length - maxChildrenToShow) + ' more children')
                    .style('font-size', '10px')
                    .style('font-style', 'italic')
                    .style('fill', 'var(--vscode-descriptionForeground)');
                yOffset += 15;
            }
        }

        // Action buttons - adjusted for smaller panel
        // const buttonY = 108; // Moved up to fit in smaller panel

        // Navigate button
        detailsGroup.append('rect')
            .attr('x', 15)
            .attr('y', buttonY)
            .attr('width', 70)
            .attr('height', 18)
            .attr('rx', 4)
            .style('fill', 'var(--vscode-button-background)')
            .style('stroke', 'var(--vscode-button-border)')
            .style('cursor', 'pointer')
            .on('click', () => {
                vscode.postMessage({
                    command: 'jumpToElement',
                    elementName: nodeData.data.name
                });
            });

        detailsGroup.append('text')
            .attr('x', 50)
            .attr('y', buttonY + 13)
            .attr('text-anchor', 'middle')
            .text('Navigate')
            .style('fill', 'var(--vscode-button-foreground)')
            .style('font-size', '10px')
            .style('cursor', 'pointer')
            .on('click', () => {
                vscode.postMessage({
                    command: 'jumpToElement',
                    elementName: nodeData.data.name
                });
            });
    }

    function renderRelationships() {
        // Only render relationships in tree view and only if we have valid data
        if (!currentData.relationships || currentData.relationships.length === 0) {
            return;
        }

        // Get all tree nodes with their positions
        const allNodes = [];
        g.selectAll('.node-group').each(function(d) {
            if (d && d.data) {
                const transform = d3.select(this).attr('transform');
                const matches = transform.match(/translate[(]([^,]+),([^)]+)[)]/);
                if (matches) {
                    allNodes.push({
                        name: d.data.name,
                        x: parseFloat(matches[0]),
                        y: parseFloat(matches[1]),
                        element: this
                    });
                }
            }
        });

        // Only draw relationships if we have valid node positions
        currentData.relationships.forEach(rel => {
            const sourceNode = allNodes.find(n => n.name === rel.source);
            const targetNode = allNodes.find(n => n.name === rel.target);

            if (sourceNode && targetNode && sourceNode.x && sourceNode.y && targetNode.x && targetNode.y) {
                g.append('line')
                    .attr('class', 'relationship-link')
                    .attr('x1', sourceNode.x)
                    .attr('y1', sourceNode.y)
                    .attr('x2', targetNode.x)
                    .attr('y2', targetNode.y);
            }
        });
    }

    // convertToHierarchy, isMetadataElement, flattenElements, extractDocumentation imported from ./helpers

    function buildHierarchicalNodes(elements, parentId = null, cyElements = [], stats = {}, parentPillarId = null) {
        elements.forEach(el => {
            const pillarId = el.pillar || parentPillarId || getPillarForElement(el);
            stats[pillarId] = (stats[pillarId] || 0) + 1;
            const nodeId = 'element-' + pillarId + '-' + slugify(el.name) + '-' + stats[pillarId];
            const lookupKey = el.name ? el.name.toLowerCase() : nodeId;
            const existing = sysmlElementLookup.get(lookupKey) || [];
            existing.push(nodeId);
            sysmlElementLookup.set(lookupKey, existing);

            const properties = normalizeAttributes(el.attributes);
            const documentation = extractDocumentation(el);
            if (documentation) {
                properties['documentation'] = documentation;
            }

            // Build label with stereotype notation
            const baseLabel = buildElementDisplayLabel(el);

            // Extract metadata from element
            const metadata = {
                documentation: documentation || null,
                properties: {}
            };

            // Copy other properties (excluding documentation)
            Object.entries(properties).forEach(function(entry) {
                const key = entry[0];
                const value = entry[1];
                if (key !== 'documentation') {
                    metadata.properties[key] = value;
                }
            });

            const nodeData = {
                id: nodeId,
                label: baseLabel,
                baseLabel: baseLabel,
                type: 'element',
                pillar: pillarId,
                color: PILLAR_COLOR_MAP[pillarId],
                sysmlType: el.type,
                elementName: el.name,
                metadata: metadata
            };

            // Set parent for compound nodes in hierarchy mode
            if (parentId) {
                nodeData.parent = parentId;
            }

            cyElements.push({
                group: 'nodes',
                data: nodeData
            });

            // Membership edges removed - pillar containers are now hidden

            // Recursively add children (excluding metadata elements)
            if (el.children && el.children.length > 0) {
                const nonMetadataChildren = el.children.filter(child =>
                    !isMetadataElement(child.type)
                );
                if (nonMetadataChildren.length > 0) {
                    buildHierarchicalNodes(nonMetadataChildren, nodeId, cyElements, stats, pillarId);
                }
            }
        });

        return cyElements;
    }

    // createLinksFromHierarchy imported from ./helpers

    function filterElements(query) {
        if (!currentData || (!currentData.elements && !currentData.pillarElements)) return;

        const searchTerm = query.toLowerCase().trim();

        if (searchTerm === '') {
            // Reset to show all elements
            filteredData = null;
            document.getElementById('status-text').textContent = 'Ready • Use filter to search elements';
        } else {
            // Filter elements based on name, type, or properties
            const filteredDiagramElements = currentData.elements
                ? filterElementsRecursive(cloneElements(currentData.elements), searchTerm)
                : [];

            filteredData = {
                ...currentData,
                elements: filteredDiagramElements
            };

            // Update status to show filter results
            const activeSource = currentData.elements;
            const activeFiltered = filteredDiagramElements;
            const totalElements = countAllElements(activeSource || []);
            const filteredCount = countAllElements(activeFiltered || []);
            document.getElementById('status-text').textContent =
                'Filtering: ' + filteredCount + ' of ' + totalElements + ' elements match "' + searchTerm + '"';
        }

        // Re-render the current view with filtered/unfiltered data
        if (currentView) {
            renderVisualization(currentView);
        }
    }

    // countAllElements, filterElementsRecursive imported from ./helpers

    function getHighlightedSvgBounds() {
        if (!g) {
            return null;
        }

        const highlighted = Array.from(g.node().querySelectorAll('.highlighted-element, .selected'));
        if (highlighted.length === 0) {
            return null;
        }

        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;

        highlighted.forEach(element => {
            if (!element || typeof element.getBBox !== 'function') {
                return;
            }
            try {
                const bbox = element.getBBox();
                if (!bbox || (bbox.width === 0 && bbox.height === 0)) {
                    return;
                }
                minX = Math.min(minX, bbox.x);
                minY = Math.min(minY, bbox.y);
                maxX = Math.max(maxX, bbox.x + bbox.width);
                maxY = Math.max(maxY, bbox.y + bbox.height);
            } catch (e) {
                // Some elements might not support getBBox
                return;
            }
        });

        if (!isFinite(minX) || !isFinite(minY) || !isFinite(maxX) || !isFinite(maxY)) {
            return null;
        }

        return {
            x: minX,
            y: minY,
            width: maxX - minX,
            height: maxY - minY
        };
    }

    function resetZoom() {
        if (currentView === 'sysml' && cy) {
            cy.reset();
            fitSysMLView(80, { preferSelection: false });
            return;
        }
        window.userHasManuallyZoomed = true; // Mark as manual interaction
        svg.transition().duration(750).call(zoom.transform, d3.zoomIdentity);
    }

    function zoomToFit(trigger = 'user') {
        const isAuto = trigger === 'auto';
        if (currentView === 'sysml' && cy) {
            fitSysMLView(80, { preferSelection: true });
            return;
        }
        if (!g || !svg) return;

        try {
            if (!isAuto) {
                window.userHasManuallyZoomed = true;
            }

            const selectionBounds = getHighlightedSvgBounds();
            const bounds = selectionBounds || g.node().getBBox();
            if (!bounds || bounds.width === 0 || bounds.height === 0) return;

            const svgWidth = +svg.attr('width');
            const svgHeight = +svg.attr('height');

            // Use tighter padding for selections, default padding otherwise
            const basePadding = selectionBounds ? 0.06 : 0.08;
            const padding = Math.min(svgWidth, svgHeight) * basePadding;

            const scaleX = (svgWidth - 2 * padding) / bounds.width;
            const scaleY = (svgHeight - 2 * padding) / bounds.height;
            const scale = Math.min(scaleX, scaleY);

            // For selections, allow zooming in more; for full view, cap at 1x
            const maxScale = selectionBounds ? 3 : 1;
            const finalScale = Math.max(Math.min(scale, maxScale), MIN_CANVAS_ZOOM);

            const centerX = svgWidth / 2;
            const centerY = svgHeight / 2;
            const boundsX = bounds.x + bounds.width / 2;
            const boundsY = bounds.y + bounds.height / 2;

            const translateX = centerX - boundsX * finalScale;
            const translateY = centerY - boundsY * finalScale;

            svg.transition()
                .duration(750)
                .call(zoom.transform, d3.zoomIdentity
                    .translate(translateX, translateY)
                    .scale(finalScale));
        } catch (error) {
            console.warn('Error in zoomToFit:', error);
            resetZoom();
        }
    }


    // Make export handlers globally accessible (from export.ts)
    window.exportPNG = (scale) => exportHandler.exportPNG(scale);
    window.exportSVG = () => exportHandler.exportSVG();
    window.exportJSON = () => exportHandler.exportJSON();
    window.resetZoom = resetZoom;
    window.zoomToFit = zoomToFit;
    window.clearSelection = clearSelection;
    window.filterElements = filterElements;

    // IBD/Interconnection View Renderer - implemented in renderers/ibd.ts

    // Activity/Action Flow View Renderer - implemented in renderers/activity.ts

    // State Transition View Renderer - implemented in renderers/state.ts

    // Use Case View Renderer - implemented in renderers/usecase.ts

    // Package View Renderer - implemented in renderers/package.ts

    // Placeholder renderer for views that cannot display a diagram (no data or not supported)
    function wrapTextToFit(line, maxCharsPerLine) {
        if (!line || line.length <= maxCharsPerLine) return [line];
        const words = line.split(/\s+/);
        const result = [];
        let current = '';
        for (const w of words) {
            const next = current ? current + ' ' + w : w;
            if (next.length <= maxCharsPerLine) {
                current = next;
            } else {
                if (current) result.push(current);
                if (w.length > maxCharsPerLine) {
                    for (let i = 0; i < w.length; i += maxCharsPerLine) {
                        result.push(w.substring(i, i + maxCharsPerLine));
                    }
                    current = '';
                } else {
                    current = w;
                }
            }
        }
        if (current) result.push(current);
        return result;
    }

    function renderPlaceholderView(width, height, viewName, message, data) {
        const centerX = width / 2;
        const centerY = height / 2;
        const messageGroup = g.append('g')
            .attr('class', 'placeholder-message')
            .attr('transform', 'translate(' + centerX + ',' + centerY + ')');

        // Message lines (handle both \n and escaped \\n)
        const rawLines = message.split(/\n|\\n/).filter(l => l.length > 0);
        const maxCharsPerLine = 38;
        const wrappedLines = [];
        rawLines.forEach(l => wrappedLines.push.apply(wrappedLines, wrapTextToFit(l, maxCharsPerLine)));
        const hasFooter = data && data.elements && data.elements.length > 0;

        // Subtle card background - height adapts to content
        const cardWidth = 320;
        const lineHeight = 22;
        const cardHeight = Math.max(120, 70 + wrappedLines.length * lineHeight + (hasFooter ? 30 : 0));
        messageGroup.append('rect')
            .attr('x', -cardWidth / 2)
            .attr('y', -cardHeight / 2)
            .attr('width', cardWidth)
            .attr('height', cardHeight)
            .attr('rx', 8)
            .attr('ry', 8)
            .style('fill', 'var(--vscode-editor-inactiveSelectionBackground)')
            .style('stroke', 'var(--vscode-panel-border)')
            .style('stroke-width', '1px');

        // View name
        messageGroup.append('text')
            .attr('x', 0)
            .attr('y', -cardHeight / 2 + 28)
            .attr('text-anchor', 'middle')
            .text(viewName)
            .style('font-size', '18px')
            .style('fill', 'var(--vscode-editor-foreground)')
            .style('font-weight', '600');

        // Render message lines (wrapped to fit card width)
        wrappedLines.forEach((line, i) => {
            messageGroup.append('text')
                .attr('x', 0)
                .attr('y', -cardHeight / 2 + 52 + (i * lineHeight))
                .attr('text-anchor', 'middle')
                .text(line)
                .style('font-size', '13px')
                .style('fill', 'var(--vscode-descriptionForeground)');
        });

        // Optional footer when model has elements
        if (data && data.elements && data.elements.length > 0) {
            messageGroup.append('text')
                .attr('x', 0)
                .attr('y', cardHeight / 2 - 20)
                .attr('text-anchor', 'middle')
                .text(data.elements.length + ' element(s) in model')
                .style('font-size', '11px')
                .style('fill', 'var(--vscode-descriptionForeground)')
                .style('opacity', '0.8');
        }
    }

    // Add event listeners for view buttons (DOM should be ready since script is at end)
    const viewDropdownBtn = document.getElementById('view-dropdown-btn');
    const viewDropdownMenu = document.getElementById('view-dropdown-menu');

    if (viewDropdownBtn && viewDropdownMenu) {
        viewDropdownBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const isVisible = viewDropdownMenu.classList.contains('show');
            viewDropdownMenu.classList.toggle('show', !isVisible);
        });
    }

    const dropdownItems = document.querySelectorAll('.view-dropdown-item');
    dropdownItems.forEach(item => {
        item.addEventListener('click', (e) => {
            const selectedView = e.currentTarget.getAttribute('data-view');
            if (viewDropdownMenu) {
                viewDropdownMenu.classList.remove('show');
            }
            if (selectedView === 'dashboard') {
                // Open the Model Dashboard panel via VS Code command
                vscode.postMessage({ command: 'executeCommand', args: ['sysml.showModelDashboard'] });
            } else if (selectedView) {
                changeView(selectedView);
            }
        });
    });

    // Set initial active view button
    updateActiveViewButton(currentView);

    // Add event listeners for action buttons
    document.getElementById('fit-btn').addEventListener('click', zoomToFit);
    document.getElementById('reset-btn').addEventListener('click', resetZoom);
    document.getElementById('layout-direction-btn').addEventListener('click', toggleLayoutDirection);
    document.getElementById('category-headers-btn').addEventListener('click', toggleCategoryHeaders);
    document.getElementById('clear-filter-btn').addEventListener('click', clearSelection);

    // Legend popup toggle
    (function setupLegend() {
        const legendBtn = document.getElementById('legend-btn');
        const legendPopup = document.getElementById('legend-popup');
        const legendCloseBtn = document.getElementById('legend-close-btn');
        if (!legendBtn || !legendPopup) return;

        function showLegend() {
            legendPopup.style.display = 'block';
            legendPopup.style.top = '12px';
            legendPopup.style.right = '12px';
            legendPopup.style.left = '';
            legendPopup.style.bottom = '';
            legendBtn.classList.add('active');
            legendBtn.style.background = 'var(--vscode-button-background)';
            legendBtn.style.color = 'var(--vscode-button-foreground)';
        }

        function hideLegend() {
            legendPopup.style.display = 'none';
            legendBtn.classList.remove('active');
            legendBtn.style.background = '';
            legendBtn.style.color = '';
        }

        legendBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const showing = legendPopup.style.display === 'block';
            if (showing) { hideLegend(); } else { showLegend(); }
        });

        if (legendCloseBtn) {
            legendCloseBtn.addEventListener('click', () => { hideLegend(); });
        }

        // Hide legend when clicking outside
        document.addEventListener('click', (e) => {
            if (legendPopup.style.display === 'block' &&
                !legendPopup.contains(e.target) &&
                !legendBtn.contains(e.target)) {
                hideLegend();
            }
        });
    })();

    // Legend drag support
    (function setupLegendDrag() {
        const legendPopup = document.getElementById('legend-popup');
        const legendHeader = document.getElementById('legend-header');
        if (!legendPopup || !legendHeader) return;

        let isDragging = false;
        let dragStartX = 0;
        let dragStartY = 0;
        let popupStartLeft = 0;
        let popupStartTop = 0;

        legendHeader.addEventListener('mousedown', (e) => {
            if (e.target.id === 'legend-close-btn') return;
            isDragging = true;
            dragStartX = e.clientX;
            dragStartY = e.clientY;
            const rect = legendPopup.getBoundingClientRect();
            const wrapperRect = legendPopup.parentElement.getBoundingClientRect();
            popupStartLeft = rect.left - wrapperRect.left;
            popupStartTop = rect.top - wrapperRect.top;
            legendPopup.style.right = '';
            legendPopup.style.left = popupStartLeft + 'px';
            legendPopup.style.top = popupStartTop + 'px';
            legendHeader.style.cursor = 'grabbing';
            e.preventDefault();
        });

        document.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            const dx = e.clientX - dragStartX;
            const dy = e.clientY - dragStartY;
            legendPopup.style.left = (popupStartLeft + dx) + 'px';
            legendPopup.style.top = (popupStartTop + dy) + 'px';
        });

        document.addEventListener('mouseup', () => {
            if (isDragging) {
                isDragging = false;
                legendHeader.style.cursor = 'grab';
            }
        });
    })();

    // About popup modal
    (function setupAboutPopup() {
        const aboutBtn = document.getElementById('about-btn');
        const aboutBackdrop = document.getElementById('about-backdrop');
        const aboutCloseBtn = document.getElementById('about-close-btn');
        const aboutRateLink = document.getElementById('about-rate-link');
        const aboutRepoLink = document.getElementById('about-repo-link');
        if (!aboutBtn || !aboutBackdrop) return;

        aboutBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            aboutBackdrop.classList.toggle('show');
        });

        if (aboutCloseBtn) {
            aboutCloseBtn.addEventListener('click', () => {
                aboutBackdrop.classList.remove('show');
            });
        }

        aboutBackdrop.addEventListener('click', (e) => {
            if (e.target === aboutBackdrop) {
                aboutBackdrop.classList.remove('show');
            }
        });

        if (aboutRateLink) {
            aboutRateLink.addEventListener('click', () => {
                vscode.postMessage({ command: 'openExternal', url: 'https://marketplace.visualstudio.com/items?itemName=Elan8.sysml-language-server' });
            });
        }

        if (aboutRepoLink) {
            aboutRepoLink.addEventListener('click', () => {
                vscode.postMessage({ command: 'openExternal', url: 'https://github.com/elan8/sysml-language-server' });
            });
        }
    })();

    // Package dropdown toggle handler
    (function setupPkgDropdown() {
        const pkgBtn = document.getElementById('pkg-dropdown-btn');
        const pkgMenu = document.getElementById('pkg-dropdown-menu');
        if (!pkgBtn || !pkgMenu) return;

        pkgBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            pkgMenu.classList.toggle('show');
            // Close view dropdown if open
            if (viewDropdownMenu) viewDropdownMenu.classList.remove('show');
        });
    })();

    // Add export dropdown functionality
const exportBtn = document.getElementById('export-btn');
const exportMenu = document.getElementById('export-menu');

    exportBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const isVisible = exportMenu.classList.contains('show');

        if (!isVisible) {
            // Position dropdown using fixed positioning for better visibility
            const btnRect = exportBtn.getBoundingClientRect();
            const menuWidth = 160;
            const menuHeight = 200; // Approximate height
            const viewportWidth = window.innerWidth;
            const viewportHeight = window.innerHeight;

            // Calculate optimal position
            let left = btnRect.right - menuWidth;
            let top = btnRect.bottom + 4;

            // Adjust if would overflow viewport
            if (left < 8) left = btnRect.left;
            if (left + menuWidth > viewportWidth - 8) left = viewportWidth - menuWidth - 8;
            if (top + menuHeight > viewportHeight - 8) top = btnRect.top - menuHeight - 4;

            exportMenu.style.left = left + 'px';
            exportMenu.style.top = top + 'px';
        }

        exportMenu.classList.toggle('show', !isVisible);
    });

    // Close dropdown when clicking outside
    document.addEventListener('click', (e) => {
        if (!exportBtn.contains(e.target) && !exportMenu.contains(e.target)) {
            exportMenu.classList.remove('show');
        }
        if (viewDropdownBtn && viewDropdownMenu &&
            !viewDropdownBtn.contains(e.target) &&
            !viewDropdownMenu.contains(e.target)) {
            viewDropdownMenu.classList.remove('show');
        }
        // Close pkg dropdown
        const pkgBtn = document.getElementById('pkg-dropdown-btn');
        const pkgMenu = document.getElementById('pkg-dropdown-menu');
        if (pkgBtn && pkgMenu && !pkgBtn.contains(e.target) && !pkgMenu.contains(e.target)) {
            pkgMenu.classList.remove('show');
        }
    });

    // Handle export menu item clicks
    document.querySelectorAll('.export-menu-item').forEach(item => {
        item.addEventListener('click', (e) => {
            const format = e.target.getAttribute('data-format');
            const scale = parseInt(e.target.getAttribute('data-scale')) || 2;

            // Don't close menu or export for parent PNG item (has submenu)
            if (format === 'png-parent') {
                e.stopPropagation();
                return;
            }

            exportMenu.classList.remove('show');

            switch(format) {
                case 'png':
                    exportHandler.exportPNG(scale);
                    break;
                case 'svg':
                    exportHandler.exportSVG();
                    break;
                case 'pdf':
                    console.warn('PDF export not implemented');
                    break;
                case 'json':
                    exportHandler.exportJSON();
                    break;
            }
        });
    });

    // ── Easter egg ─────────────────────────────────────────────
    (function initEasterEgg() {
        var egg = document.getElementById('ee-egg');
        var trigger = document.getElementById('legend-btn');
        if (!egg || !trigger) return;

        var hoverTimer = null;
        var HOLD_MS = 3000; // hold 3 seconds to reveal
        var revealed = false;

        trigger.addEventListener('mouseenter', function () {
            if (revealed) return;
            hoverTimer = setTimeout(function () {
                revealed = true;
                egg.classList.add('revealed');
                // little wobble on first appearance
                egg.classList.add('hatch');
                egg.addEventListener('animationend', function () {
                    egg.classList.remove('hatch');
                }, { once: true });
            }, HOLD_MS);
        });

        trigger.addEventListener('mouseleave', function () {
            if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = null; }
        });

        egg.addEventListener('click', function () {
            egg.textContent = '🐣';
            egg.classList.add('hatch');
            egg.addEventListener('animationend', function () {
                egg.classList.remove('hatch');
            }, { once: true });
            vscode.postMessage({ command: 'executeCommand', args: ['sysml.showSysRunner'] });
        });
    })();

    // webviewReady is sent from initializeLegacyBundle after vscode is set
