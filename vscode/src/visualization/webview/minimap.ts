/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Minimap controller for diagram navigation.
 * Uses getState() to access svg, g, zoom, cy, currentView.
 */

export interface MinimapState {
    svg: any;
    g: any;
    zoom: any;
    cy: any;
    currentView: string;
}

export interface MinimapController {
    initMinimap: () => void;
    updateMinimap: () => void;
}

export function createMinimapController(
    getState: () => MinimapState
): MinimapController {
    let minimapVisible = true;
    let minimapDragging = false;

    function navigateFromMinimap(event: MouseEvent): void {
        const { svg, g, zoom } = getState();
        const canvas = document.getElementById('minimap-canvas');
        if (!canvas || !svg || !g || !zoom) return;

        const rect = canvas.getBoundingClientRect();
        const x = event.clientX - rect.left;
        const y = event.clientY - rect.top;

        const gNode = (g as any).node();
        if (!gNode) return;
        const bounds = (gNode as SVGGraphicsElement).getBBox();
        if (!bounds || bounds.width === 0 || bounds.height === 0) return;

        const padding = 10;
        const canvasWidth = canvas.width;
        const canvasHeight = canvas.height;
        const scaleX = (canvasWidth - 2 * padding) / bounds.width;
        const scaleY = (canvasHeight - 2 * padding) / bounds.height;
        const scale = Math.min(scaleX, scaleY);

        const offsetX = padding + (canvasWidth - 2 * padding - bounds.width * scale) / 2;
        const offsetY = padding + (canvasHeight - 2 * padding - bounds.height * scale) / 2;

        const contentX = bounds.x + (x - offsetX) / scale;
        const contentY = bounds.y + (y - offsetY) / scale;

        const d3 = (window as any).d3;
        const currentTransform = d3.zoomTransform(svg.node());
        const svgWidth = +svg.attr('width');
        const svgHeight = +svg.attr('height');

        const translateX = svgWidth / 2 - contentX * currentTransform.k;
        const translateY = svgHeight / 2 - contentY * currentTransform.k;

        svg.transition()
            .duration(300)
            .call(zoom.transform, d3.zoomIdentity
                .translate(translateX, translateY)
                .scale(currentTransform.k));
    }

    function updateMinimapCytoscape(
        canvas: HTMLCanvasElement,
        viewport: HTMLElement,
        container: HTMLElement,
        cy: any
    ): void {
        if (!cy) return;

        const containerRect = container.getBoundingClientRect();
        canvas.width = containerRect.width;
        canvas.height = containerRect.height - 22;

        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        ctx.clearRect(0, 0, canvas.width, canvas.height);

        const bb = cy.elements().boundingBox();
        if (bb.w === 0 || bb.h === 0) return;

        const padding = 10;
        const scaleX = (canvas.width - 2 * padding) / bb.w;
        const scaleY = (canvas.height - 2 * padding) / bb.h;
        const scale = Math.min(scaleX, scaleY);

        const offsetX = padding + (canvas.width - 2 * padding - bb.w * scale) / 2;
        const offsetY = padding + (canvas.height - 2 * padding - bb.h * scale) / 2;

        ctx.fillStyle = 'rgba(100, 150, 200, 0.6)';
        cy.nodes().forEach((node: any) => {
            const pos = node.position();
            const w = node.width() * scale;
            const h = node.height() * scale;
            const x = offsetX + (pos.x - bb.x1 - node.width() / 2) * scale;
            const y = offsetY + (pos.y - bb.y1 - node.height() / 2) * scale;
            ctx.fillRect(x, y, Math.max(w, 2), Math.max(h, 2));
        });

        ctx.strokeStyle = 'rgba(150, 150, 150, 0.5)';
        ctx.lineWidth = 0.5;
        cy.edges().forEach((edge: any) => {
            const source = edge.source().position();
            const target = edge.target().position();
            const x1 = offsetX + (source.x - bb.x1) * scale;
            const y1 = offsetY + (source.y - bb.y1) * scale;
            const x2 = offsetX + (target.x - bb.x1) * scale;
            const y2 = offsetY + (target.y - bb.y1) * scale;
            ctx.beginPath();
            ctx.moveTo(x1, y1);
            ctx.lineTo(x2, y2);
            ctx.stroke();
        });

        const cyExtent = cy.extent();
        const viewWidth = (cyExtent.x2 - cyExtent.x1) * scale;
        const viewHeight = (cyExtent.y2 - cyExtent.y1) * scale;
        const viewX = offsetX + (cyExtent.x1 - bb.x1) * scale;
        const viewY = offsetY + (cyExtent.y1 - bb.y1) * scale;

        viewport.style.left = (viewX + container.offsetLeft) + 'px';
        viewport.style.top = (viewY + 22) + 'px';
        viewport.style.width = Math.max(viewWidth, 10) + 'px';
        viewport.style.height = Math.max(viewHeight, 10) + 'px';
        viewport.style.display = 'block';
    }

    function updateMinimapViewport(
        canvas: HTMLCanvasElement,
        viewport: HTMLElement,
        bounds: DOMRect,
        scale: number,
        offsetX: number,
        offsetY: number,
        svg: any,
        zoom: any
    ): void {
        if (!svg || !zoom) return;

        try {
            const d3 = (window as any).d3;
            const transform = d3.zoomTransform(svg.node());
            const svgWidth = +svg.attr('width');
            const svgHeight = +svg.attr('height');

            const visibleX = -transform.x / transform.k;
            const visibleY = -transform.y / transform.k;
            const visibleWidth = svgWidth / transform.k;
            const visibleHeight = svgHeight / transform.k;

            const vpX = offsetX + (visibleX - bounds.x) * scale;
            const vpY = offsetY + (visibleY - bounds.y) * scale;
            const vpWidth = visibleWidth * scale;
            const vpHeight = visibleHeight * scale;

            viewport.style.left = Math.max(0, vpX) + 'px';
            viewport.style.top = (Math.max(0, vpY) + 22) + 'px';
            viewport.style.width = Math.min(vpWidth, canvas.width) + 'px';
            viewport.style.height = Math.min(vpHeight, canvas.height) + 'px';
            viewport.style.display = 'block';
        } catch (e) {
            viewport.style.display = 'none';
        }
    }

    function updateMinimap(): void {
        if (!minimapVisible) return;

        const { svg, g, zoom, cy, currentView } = getState();
        const container = document.getElementById('minimap-container');
        const canvas = document.getElementById('minimap-canvas') as HTMLCanvasElement | null;
        const viewport = document.getElementById('minimap-viewport');

        if (!container || !canvas || !viewport) return;

        if (currentView === 'sysml' && cy) {
            updateMinimapCytoscape(canvas, viewport, container, cy);
            container.style.display = 'block';
            return;
        }

        if (!svg || !g) {
            container.style.display = 'none';
            return;
        }

        container.style.display = 'block';

        const gNode = (g as any).node();
        if (!gNode) return;

        const bounds = (gNode as SVGGraphicsElement).getBBox();
        if (!bounds || bounds.width === 0 || bounds.height === 0) return;

        const containerRect = container.getBoundingClientRect();
        canvas.width = containerRect.width;
        canvas.height = containerRect.height - 22;

        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        ctx.clearRect(0, 0, canvas.width, canvas.height);

        const padding = 10;
        const scaleX = (canvas.width - 2 * padding) / bounds.width;
        const scaleY = (canvas.height - 2 * padding) / bounds.height;
        const scale = Math.min(scaleX, scaleY);

        const offsetX = padding + (canvas.width - 2 * padding - bounds.width * scale) / 2;
        const offsetY = padding + (canvas.height - 2 * padding - bounds.height * scale) / 2;

        ctx.fillStyle = 'rgba(100, 150, 200, 0.6)';
        ctx.strokeStyle = 'rgba(100, 150, 200, 0.8)';
        ctx.lineWidth = 1;

        const nodes = g.selectAll('rect, circle, ellipse, polygon').nodes();
        nodes.forEach((node: any) => {
            try {
                const bbox = node.getBBox();
                if (bbox.width > 5 && bbox.height > 5) {
                    const x = offsetX + (bbox.x - bounds.x) * scale;
                    const y = offsetY + (bbox.y - bounds.y) * scale;
                    const w = bbox.width * scale;
                    const h = bbox.height * scale;
                    if (w > 1 && h > 1) {
                        ctx.fillRect(x, y, Math.max(w, 2), Math.max(h, 2));
                        ctx.strokeRect(x, y, Math.max(w, 2), Math.max(h, 2));
                    }
                }
            } catch (e) {
                // Skip elements that can't provide bbox
            }
        });

        ctx.strokeStyle = 'rgba(150, 150, 150, 0.5)';
        ctx.lineWidth = 0.5;
        const paths = g.selectAll('path, line').nodes();
        paths.forEach((path: any) => {
            try {
                const bbox = path.getBBox();
                if (bbox.width > 0 || bbox.height > 0) {
                    const x1 = offsetX + (bbox.x - bounds.x) * scale;
                    const y1 = offsetY + (bbox.y - bounds.y) * scale;
                    const x2 = x1 + bbox.width * scale;
                    const y2 = y1 + bbox.height * scale;
                    ctx.beginPath();
                    ctx.moveTo(x1, y1);
                    ctx.lineTo(x2, y2);
                    ctx.stroke();
                }
            } catch (e) {
                // Skip
            }
        });

        updateMinimapViewport(canvas, viewport, bounds, scale, offsetX, offsetY, svg, zoom);
    }

    function initMinimap(): void {
        const container = document.getElementById('minimap-container');
        const canvas = document.getElementById('minimap-canvas');
        const toggle = document.getElementById('minimap-toggle');
        const toolbarBtn = document.getElementById('minimap-toolbar-btn');

        if (!container || !canvas || !toggle) return;

        function toggleMinimapVisibility(): void {
            minimapVisible = !minimapVisible;
            if (minimapVisible) {
                container.style.display = 'block';
                toggle.textContent = '−';
                toggle.title = 'Hide minimap';
                if (toolbarBtn) {
                    toolbarBtn.classList.add('active');
                    (toolbarBtn as HTMLElement).style.background = 'var(--vscode-button-background)';
                    (toolbarBtn as HTMLElement).style.color = 'var(--vscode-button-foreground)';
                }
                updateMinimap();
            } else {
                container.style.display = 'none';
                toggle.textContent = '+';
                toggle.title = 'Show minimap';
                if (toolbarBtn) {
                    toolbarBtn.classList.remove('active');
                    (toolbarBtn as HTMLElement).style.background = '';
                    (toolbarBtn as HTMLElement).style.color = '';
                }
            }
        }

        toggle.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleMinimapVisibility();
        });

        if (toolbarBtn) {
            toolbarBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                toggleMinimapVisibility();
            });
            toolbarBtn.classList.add('active');
            (toolbarBtn as HTMLElement).style.background = 'var(--vscode-button-background)';
            (toolbarBtn as HTMLElement).style.color = 'var(--vscode-button-foreground)';
        }

        function handleMinimapClick(event: MouseEvent): void {
            minimapDragging = true;
            navigateFromMinimap(event);
        }

        function handleMinimapDrag(event: MouseEvent): void {
            if (minimapDragging) {
                navigateFromMinimap(event);
            }
        }

        canvas.addEventListener('mousedown', handleMinimapClick);
        canvas.addEventListener('mousemove', handleMinimapDrag);
        canvas.addEventListener('mouseup', () => { minimapDragging = false; });
        canvas.addEventListener('mouseleave', () => { minimapDragging = false; });
    }

    return {
        initMinimap,
        updateMinimap
    };
}
