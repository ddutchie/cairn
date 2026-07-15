/**
 * Builder for the self-contained Knowledge Graph WebView document — the D3
 * library plus the injected force-simulation + radial-sunburst rendering JS.
 *
 * Extracted from KnowledgeGraphWebView.tsx (which had grown past 1,000 lines)
 * so the React component stays focused on state, messaging and toolbar chrome.
 * Everything below the opening `return` lives INSIDE a template literal — it is
 * the WebView's own runtime JS, not TypeScript — and only interpolates the
 * `payload` (graph data + theme JSON) and the bundled `D3_JS` source.
 */

import { D3_JS } from "@/webview-assets/d3-assets";

export function buildGraphHtml(payload: string): string {
  return `<!doctype html><html><head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
    <style>
      html, body { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; }
      #g { width: 100vw; height: 100vh; display: block; -webkit-tap-highlight-color: transparent; }
      text { font-family: -apple-system, system-ui, sans-serif; -webkit-user-select: none; user-select: none; }
    </style>
  </head><body>
    <svg id="g"></svg>
    <script>${D3_JS}</script>
    <script>
      (function () {
        var DATA = ${payload};
        var W = window.innerWidth, H = window.innerHeight;
        var post = function (o) { window.ReactNativeWebView && window.ReactNativeWebView.postMessage(JSON.stringify(o)); };

        function withAlpha(c, a) {
          var h = String(c).replace('#', '');
          if (h.length === 3) h = h.split('').map(function (x) { return x + x; }).join('');
          var r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
          if (isNaN(r) || isNaN(g) || isNaN(b)) return c;
          return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
        }

        var svg = d3.select('#g').attr('viewBox', [0, 0, W, H]);
        if (DATA.mode === 'radial') { renderRadial(); } else { renderForce(); }

        // ══ FORCE-DIRECTED ═══════════════════════════════════════════════════
        function renderForce() {
          var root = svg.append('g');

          // cluster hulls
          var hullLayer = root.append('g');
          var hullLine = d3.line().curve(d3.curveCatmullRomClosed.alpha(0.6));
          var projectsById = {};
          DATA.nodes.forEach(function (n) { if (n.isProject) projectsById[n.id] = n; });
          var membersByProject = {};
          DATA.nodes.forEach(function (n) {
            var pid = n.isProject ? n.id : n.projectId;
            if (!pid || !projectsById[pid]) return;
            (membersByProject[pid] = membersByProject[pid] || []).push(n);
          });
          function drawHulls() {
            if (!DATA.showHulls) { hullLayer.selectAll('path').remove(); return; }
            var polys = [];
            Object.keys(membersByProject).forEach(function (pid) {
              var pts = membersByProject[pid]
                .filter(function (n) { return n.x != null && n.y != null; })
                .map(function (n) { return [n.x, n.y]; });
              if (pts.length < 3) return;
              var hull = d3.polygonHull(pts);
              if (!hull) return;
              var cx = d3.mean(hull, function (d) { return d[0]; });
              var cy = d3.mean(hull, function (d) { return d[1]; });
              var pad = 22;
              var expanded = hull.map(function (p) {
                var dx = p[0] - cx, dy = p[1] - cy, m = Math.hypot(dx, dy) || 1;
                return [p[0] + (dx / m) * pad, p[1] + (dy / m) * pad];
              });
              polys.push(hullLine(expanded));
            });
            var paths = hullLayer.selectAll('path').data(polys);
            paths.exit().remove();
            paths.enter().append('path')
              .attr('fill', withAlpha(DATA.theme.accent, 0.05))
              .attr('stroke', withAlpha(DATA.theme.accent, 0.18))
              .attr('stroke-width', 1.2)
              .merge(paths)
              .attr('d', function (d) { return d; });
          }

          var link = root.append('g').selectAll('line').data(DATA.links).join('line')
            .attr('stroke', function (d) { return d.color; })
            .attr('stroke-opacity', function (d) { return d.opacity; })
            .attr('stroke-width', function (d) { return d.width || 1; })
            .attr('stroke-dasharray', function (d) { return d.dash ? '3,3' : null; });

          var selectedId = null, hoveredId = null;
          var currentK = 0.85;
          var node = root.append('g').selectAll('g').data(DATA.nodes).join('g').style('cursor', 'pointer');
          var circles = node.append('circle')
            .attr('r', function (d) { return d.r; })
            .attr('fill', function (d) { return withAlpha(d.color, 0.92); })
            .attr('stroke', function (d) { return d.color; })
            .attr('stroke-width', 0);

          var labels = node.append('text')
            .attr('text-anchor', 'middle')
            .attr('paint-order', 'stroke')
            .attr('stroke', DATA.theme.bg)
            .attr('stroke-linejoin', 'round')
            .attr('stroke-width', 3)
            .text(function (d) {
              return d.title.length > d.labelMax ? d.title.slice(0, d.labelMax - 1) + '…' : d.title;
            });

          function labelVisible(d, k) {
            if (d.isProject || d.id === selectedId || d.id === hoveredId) return true;
            if (DATA.labelMode === 'all') return k >= 0.7;
            if (DATA.labelMode === 'smart') return k >= 1.5;
            return false;
          }
          function updateLabels(k) {
            labels
              .attr('display', function (d) { return labelVisible(d, k) ? null : 'none'; })
              .attr('font-size', function (d) { return d.labelPx; })
              .attr('font-weight', function (d) { return d.isProject ? '600' : '400'; })
              .attr('y', function (d) { return d.r + 4 + d.labelPx; })
              .attr('fill', function (d) { return d.isProject ? DATA.theme.text : DATA.theme.textSecondary; });
          }
          updateLabels(1);

          node.on('click', function (e, d) { post({ type: 'select', id: d.id, nodeType: d.type }); });

          var sim = d3.forceSimulation(DATA.nodes)
            .force('link', d3.forceLink(DATA.links).id(function (d) { return d.id; })
              .distance(function (l) { return l.distance; }).strength(DATA.forces.linkStrength))
            .force('charge', d3.forceManyBody().strength(function (d) { return d.charge; }))
            .force('x', d3.forceX(function (d) { return W / 2 + d.anchorX; }).strength(function (d) { return d.anchorStrength; }))
            .force('y', d3.forceY(function (d) { return H / 2 + d.anchorY; }).strength(function (d) { return d.anchorStrength; }))
            .force('collide', d3.forceCollide().radius(function (d) { return d.collideR; }).iterations(DATA.forces.collideIterations))
            .alphaDecay(DATA.forces.alphaDecay)
            .velocityDecay(DATA.forces.velocityDecay)
            .on('tick', function () {
              drawHulls();
              link
                .attr('x1', function (d) { return d.source.x; })
                .attr('y1', function (d) { return d.source.y; })
                .attr('x2', function (d) { return d.target.x; })
                .attr('y2', function (d) { return d.target.y; });
              node.attr('transform', function (d) { return 'translate(' + d.x + ',' + d.y + ')'; });
            });

          var zoom = d3.zoom().scaleExtent([0.2, 6]).on('zoom', function (e) {
            currentK = e.transform.k;
            root.attr('transform', e.transform);
            circles.attr('stroke-width', function (d) {
              return (d.id === selectedId || d.id === hoveredId) ? 1.6 / e.transform.k : 0;
            });
            updateLabels(e.transform.k);
          });
          svg.call(zoom);
          svg.call(zoom.transform, d3.zoomIdentity.translate(W / 2, H / 2).scale(0.85).translate(-W / 2, -H / 2));

          // Zoom-to-fit: frame every node's bounding box (padded for their radii
          // + labels) into the viewport. Exposed for the native "fit" button,
          // which injects window.__fit().
          window.__fit = function () {
            if (!DATA.nodes.length) return;
            var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            DATA.nodes.forEach(function (d) {
              if (d.x == null || d.y == null) return;
              var pad = d.r + 8;
              if (d.x - pad < minX) minX = d.x - pad;
              if (d.y - pad < minY) minY = d.y - pad;
              if (d.x + pad > maxX) maxX = d.x + pad;
              if (d.y + pad > maxY) maxY = d.y + pad;
            });
            if (!isFinite(minX)) return;
            var bw = Math.max(1, maxX - minX), bh = Math.max(1, maxY - minY);
            var margin = 40;
            var k = Math.min((W - margin) / bw, (H - margin) / bh);
            k = Math.max(0.2, Math.min(6, k));
            var cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
            var tf = d3.zoomIdentity.translate(W / 2, H / 2).scale(k).translate(-cx, -cy);
            svg.transition().duration(450).call(zoom.transform, tf);
          };

          node.call(d3.drag()
            .on('start', function (e, d) { if (!e.active) sim.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
            .on('drag', function (e, d) { d.fx = e.x; d.fy = e.y; })
            .on('end', function (e, d) { if (!e.active) sim.alphaTarget(0); d.fx = null; d.fy = null; }));

          // ── In-place updates for cheap toggles (no full document reload) ──
          // The native side calls window.__update({...}) via injectJavaScript for
          // hulls / labels / semantic-link changes so we don't rebuild the whole
          // graph + restart the simulation from scratch.
          window.__update = function (patch) {
            if (patch.showHulls != null) {
              DATA.showHulls = patch.showHulls;
              drawHulls();
            }
            if (patch.labelMode != null) {
              DATA.labelMode = patch.labelMode;
              updateLabels(currentK);
            }
            if (patch.links != null) {
              DATA.links = patch.links;
              // Rebind link selection (semantic edges added/removed).
              link = link.data(DATA.links, function (d) {
                var s = (d.source && d.source.id) || d.source;
                var tt = (d.target && d.target.id) || d.target;
                return s + '\u2192' + tt;
              });
              link.exit().remove();
              link = link.enter().append('line')
                .attr('stroke', function (d) { return d.color; })
                .attr('stroke-opacity', function (d) { return d.opacity; })
                .attr('stroke-width', function (d) { return d.width || 1; })
                .attr('stroke-dasharray', function (d) { return d.dash ? '3,3' : null; })
                .merge(link);
              // Re-seed the link force with the new links and give the sim a
              // gentle nudge (not a full restart) so new edges settle in.
              sim.force('link').links(DATA.links);
              sim.alpha(0.3).restart();
            }
          };
        }

        // ══ RADIAL / SUNBURST ════════════════════════════════════════════════
        function renderRadial() {
          var INNER_R = 38, INNER_R_FOCUSED = 120;
          var cx = W / 2, cy = H / 2;
          var maxR = Math.min(W, H) / 2 - 20;

          var root = d3.hierarchy(DATA.hierarchy)
            .sum(function (d) { return (d.children && d.children.length) ? 0 : 1; })
            .sort(function (a, b) { return (b.value || 0) - (a.value || 0); });
          d3.partition().size([2 * Math.PI, root.height + 1])(root);

          var focus = root;
          var g = svg.append('g').attr('transform', 'translate(' + cx + ',' + cy + ')');

          function visibleLevels(f) { return Math.max(1, root.height - f.depth); }
          function innerRadiusFor(f) { return f === root ? INNER_R : Math.min(INNER_R_FOCUSED, maxR * 0.45); }
          function ringR(y, innerR, levels) {
            var band = (maxR - innerR) / levels;
            return innerR + Math.min(y, levels) * band;
          }
          function targetArc(d) {
            var span = (focus.x1 - focus.x0) || 1;
            var x0 = Math.max(0, Math.min(1, (d.x0 - focus.x0) / span)) * 2 * Math.PI;
            var x1 = Math.max(0, Math.min(1, (d.x1 - focus.x0) / span)) * 2 * Math.PI;
            var y0 = Math.max(0, d.y0 - focus.depth - 1);
            var y1 = Math.max(0, d.y1 - focus.depth - 1);
            return { x0: x0, x1: x1, y0: y0, y1: y1 };
          }

          var arcGen = d3.arc()
            .startAngle(function (a) { return a.x0; })
            .endAngle(function (a) { return a.x1; })
            .innerRadius(function (a) { return a._r0; })
            .outerRadius(function (a) { return a._r1; })
            .padAngle(0.004)
            .padRadius(maxR);

          var wedges = g.append('g');
          var hub = g.append('g');

          // Persisted per-node arc state so drill-in / back can be tweened
          // (mirrors desktop zoomTo): current = where each wedge is drawn now.
          var current = new Map();
          var animGeom = { innerR: innerRadiusFor(root), levels: visibleLevels(root) };
          var animId = 0;

          function drawFrame() {
            var innerR = animGeom.innerR;
            var levels = animGeom.levels;
            var arcs = [];
            root.each(function (d) {
              if (d === root) return;
              var a = current.get(d) || targetArc(d);
              if (a.x1 - a.x0 < 0.002 || a.y1 <= 0) return;
              a._r0 = ringR(a.y0, innerR, levels);
              a._r1 = ringR(a.y1, innerR, levels) - 1.5;
              if (a._r1 <= a._r0) return;
              a._d = d;
              arcs.push(a);
            });
            render(arcs, innerR);
          }

          // Animate the focus change: interpolate every node's arc + the ring
          // geometry from their current values to the new focus targets.
          function zoomTo(node) {
            var fromInnerR = animGeom.innerR;
            var fromLevels = animGeom.levels;
            focus = node;
            var toInnerR = innerRadiusFor(node);
            var toLevels = visibleLevels(node);
            var from = new Map();
            var to = new Map();
            root.each(function (d) {
              from.set(d, current.get(d) || targetArc(d));
              to.set(d, targetArc(d));
            });
            var start = null;
            var dur = 520;
            cancelAnimationFrame(animId);
            function tick(now) {
              if (start === null) start = now;
              var t = Math.min(1, (now - start) / dur);
              var e = d3.easeCubicInOut(t);
              animGeom = {
                innerR: fromInnerR + (toInnerR - fromInnerR) * e,
                levels: fromLevels + (toLevels - fromLevels) * e,
              };
              root.each(function (d) {
                var a = from.get(d), b = to.get(d);
                current.set(d, {
                  x0: a.x0 + (b.x0 - a.x0) * e,
                  x1: a.x1 + (b.x1 - a.x1) * e,
                  y0: a.y0 + (b.y0 - a.y0) * e,
                  y1: a.y1 + (b.y1 - a.y1) * e,
                });
              });
              drawFrame();
              if (t < 1) animId = requestAnimationFrame(tick);
            }
            animId = requestAnimationFrame(tick);
          }

          function render(arcs, innerR) {
            var sel = wedges.selectAll('path').data(arcs, function (a) { return a._d.data.id; });
            sel.exit().remove();
            sel.enter().append('path')
              .style('cursor', 'pointer')
              .on('click', function (e, a) {
                var d = a._d;
                if (d.data.type !== 'workspace' && d.data.type !== 'branch') {
                  post({ type: 'select', id: d.data.id, nodeType: d.data.type });
                }
                if (d.children && d.children.length) { zoomTo(d); }
              })
              .merge(sel)
              .attr('d', function (a) { return arcGen(a); })
              .attr('fill', function (a) {
                var isBranch = a._d.depth === focus.depth + 1 && a._d.children && a._d.children.length;
                return withAlpha(a._d.data.color, isBranch ? 1 : 0.62);
              })
              .attr('stroke', DATA.theme.bg)
              .attr('stroke-width', 1);

            // labels — branches (wide inner ring) get centred labels; leaves radial.
            var labelSel = wedges.selectAll('text').data(arcs.filter(function (a) {
              var isBranch = a._d.depth === focus.depth + 1 && a._d.children && a._d.children.length;
              var arcLenInner = (a.x1 - a.x0) * a._r0;
              return isBranch || (arcLenInner >= 9 && (a.x1 - a.x0) > 0.012 && (a._r1 - a._r0) > 12);
            }), function (a) { return 'L' + a._d.data.id; });
            labelSel.exit().remove();
            labelSel.enter().append('text').merge(labelSel)
              .each(function (a) {
                var d = a._d;
                var ang = (a.x0 + a.x1) / 2;
                var isBranch = d.depth === focus.depth + 1 && d.children && d.children.length;
                var flip = ang >= Math.PI;
                var fontPx = isBranch ? 12 : 11;
                var ringDepth = a._r1 - a._r0;
                var maxChars = Math.max(2, Math.floor((ringDepth - 8) / (fontPx * 0.58)));
                var label = d.data.title;
                if (label.length > maxChars) label = label.slice(0, maxChars - 1) + '…';
                var el = d3.select(this)
                  .text(label)
                  .attr('font-size', fontPx)
                  .attr('font-weight', isBranch ? '600' : '400')
                  .attr('fill', isBranch ? DATA.theme.accentFg : DATA.theme.text)
                  .attr('dominant-baseline', 'middle');
                var rot = (ang - Math.PI / 2) * 180 / Math.PI;
                if (isBranch) {
                  var rr = (a._r0 + a._r1) / 2;
                  el.attr('text-anchor', 'middle')
                    .attr('transform', 'rotate(' + rot + ') translate(' + rr + ',0)' + (flip ? ' rotate(180)' : ''));
                } else if (flip) {
                  el.attr('text-anchor', 'start')
                    .attr('transform', 'rotate(' + rot + ') translate(' + (a._r1 - 4) + ',0) rotate(180)');
                } else {
                  el.attr('text-anchor', 'start')
                    .attr('transform', 'rotate(' + rot + ') translate(' + (a._r0 + 4) + ',0)');
                }
              });

            // hub — focus label + back affordance
            hub.selectAll('*').remove();
            hub.append('circle')
              .attr('r', innerR - 3)
              .attr('fill', withAlpha(DATA.theme.surface, 0.95))
              .attr('stroke', focus === root ? DATA.theme.border : withAlpha(DATA.theme.accent, 0.5))
              .attr('stroke-width', focus === root ? 1 : 1.5)
              .style('cursor', focus === root ? 'default' : 'pointer')
              .on('click', function () { if (focus !== root) { zoomTo(focus.parent || root); } });
            if (focus === root) {
              hub.append('text').text('Workspace')
                .attr('text-anchor', 'middle').attr('dominant-baseline', 'middle')
                .attr('font-size', 11).attr('font-weight', '600').attr('fill', DATA.theme.textSecondary);
            } else {
              var title = focus.data.title.length > 18 ? focus.data.title.slice(0, 17) + '…' : focus.data.title;
              hub.append('text').text(title)
                .attr('text-anchor', 'middle').attr('y', -8)
                .attr('font-size', 14).attr('font-weight', '600').attr('fill', DATA.theme.text);
              hub.append('text').text('← back')
                .attr('text-anchor', 'middle').attr('y', 14)
                .attr('font-size', 11).attr('fill', withAlpha(DATA.theme.accent, 0.9))
                .style('cursor', 'pointer')
                .on('click', function () { zoomTo(focus.parent || root); });
            }
          }

          // Seed resting positions, then paint the first frame.
          root.each(function (d) { if (!current.has(d)) current.set(d, targetArc(d)); });
          drawFrame();
        }
      })();
    </script>
  </body></html>`;
}
