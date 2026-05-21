import { layout } from './layout.js';

export function renderGraph() {
  const main = `
    <h2>Knowledge graph</h2>
    <p class="muted">Top entities and relations. Click a node to drill down.</p>
    <div id="graph" style="height: 70vh; border:1px solid #333; border-radius:8px;"></div>
    <script src="https://unpkg.com/vis-network@9.1.9/standalone/umd/vis-network.min.js"></script>
    <script>
      (async () => {
        const res = await fetch('/api/graph');
        const data = await res.json();
        const container = document.getElementById('graph');
        const network = new vis.Network(container, data, {
          nodes: { shape: 'dot', size: 14, font: { color: '#ddd' }, color: { background: '#3a86ff', border: '#0066cc' } },
          edges: { arrows: 'to', color: { color: '#666' }, font: { color: '#aaa', size: 10 } },
          physics: { stabilization: true, barnesHut: { gravitationalConstant: -3000 } }
        });
        network.on('click', (params) => {
          if (params.nodes && params.nodes.length > 0) {
            window.location.href = '/entity/' + params.nodes[0];
          }
        });
      })();
    </script>
  `;
  return layout({ title: 'graph', main, activeNav: 'Graph' });
}
