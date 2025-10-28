let network, allNodes, allEdges, ws;
let physicsEnabled = true;
let dockerAvailable = false;


document.addEventListener('DOMContentLoaded', () => {
    allNodes = new vis.DataSet();
    allEdges = new vis.DataSet();
    initNetwork();
    loadData();
    connectWebSocket();
});


function initNetwork() {
    const container = document.getElementById('network');
    const data = { nodes: allNodes, edges: allEdges };
    
    network = new vis.Network(container, data, {
        nodes: {
            shape: 'box',
            margin: 10,
            font: { size: 11, face: 'Inter, sans-serif' },
            borderWidth: 2
        },
        edges: {
            arrows: { to: { enabled: true } },
            smooth: { enabled: true },
            font: { size: 9 },
            color: { color: '#94a3b8', highlight: '#6366f1' }
        },
        physics: { enabled: physicsEnabled },
        interaction: { dragNodes: true, zoomView: true, hover: true }
    });
}


async function loadData() {
    try {
        const response = await axios.get('/api/network-data');
        dockerAvailable = response.data.docker_available !== false;
        
        updateUIForDockerStatus();
        
        if (dockerAvailable && !response.data.error) {
            updateVisualization(response.data);
            updateSummary(response.data.summary);
            updateContainerList(response.data.containers);
            hideNoDataOverlay();
        } else {
            showError(response.data.error || 'Docker недоступен');
            showNoDataOverlay();
        }
    } catch (error) {
        showError('Ошибка подключения');
        showNoDataOverlay();
    }
}


function updateVisualization(data) {
    const nodes = Object.entries(data.containers).map(([id, container]) => {
        const isRunning = container.status === 'running';
        return {
            id: id,
            label: `📦 ${container.name}\n🆔 ${id.substring(0, 8)}\n${isRunning ? '🟢' : '🔴'} ${container.status}`,
            color: isRunning ? 
                { background: '#dcfce7', border: '#16a34a' } : 
                { background: '#fecaca', border: '#dc2626' },
            shape: 'box'
        };
    });

    const edges = data.connections.map(conn => ({
        id: conn.id,
        from: conn.source,
        to: conn.target,
        label: ` ${conn.network} `,
        arrows: 'to'
    }));

    allNodes.clear();
    allEdges.clear();
    
    if (nodes.length > 0) allNodes.add(nodes);
    if (edges.length > 0) allEdges.add(edges);

    if (nodes.length > 0) {
        setTimeout(() => network.fit({ animation: true }), 500);
    }
}


function updateSummary(summary) {
    const stats = {
        'statContainers': summary.total_containers || 0,
        'statRunning': summary.running_containers || 0,
        'statNetworks': summary.total_networks || 0,
        'statConnections': summary.total_connections || 0
    };

    Object.entries(stats).forEach(([id, value]) => {
        const element = document.getElementById(id);
        if (element) {
            element.querySelector('.stat-number').textContent = value;
        }
    });
}


function updateContainerList(containers) {
    const containerList = document.getElementById('containerList');
    
    if (Object.keys(containers).length === 0) {
        containerList.innerHTML = `
            <div class="container-placeholder">
                <div class="placeholder-icon">📦</div>
                <div class="placeholder-text">Контейнеры не найдены</div>
            </div>
        `;
        return;
    }
    
    containerList.innerHTML = Object.entries(containers).map(([id, container]) => {
        const isRunning = container.status === 'running';
        return `
            <div class="container-item ${isRunning ? 'running' : 'stopped'}">
                <div class="container-header">
                    <div class="container-name">📦 ${container.name}</div>
                    <div class="container-status ${isRunning ? 'status-running' : 'status-stopped'}">
                        ${isRunning ? '🟢 Запущен' : '🔴 Остановлен'}
                    </div>
                </div>
                <div class="container-details">
                    <div>🆔 ${id.substring(0, 12)}</div>
                    <div>🖼️ ${container.image}</div>
                </div>
            </div>
        `;
    }).join('');
}


function updateUIForDockerStatus() {
    const noDataOverlay = document.getElementById('noDataOverlay');
    if (dockerAvailable) {
        noDataOverlay?.classList.remove('show');
    } else {
        noDataOverlay?.classList.add('show');
    }
}

function showError(message) {
    console.error('Error:', message);
}

function showNoDataOverlay() {
    document.getElementById('noDataOverlay')?.classList.add('show');
}

function hideNoDataOverlay() {
    document.getElementById('noDataOverlay')?.classList.remove('show');
}


async function exportPlantUML() {
    try {
        const response = await axios.get('/api/plantuml');
        downloadFile(response.data.plantuml, 'docker-network.puml', 'text/plain');
        showNotification('PlantUML экспортирован!');
    } catch (error) {
        showNotification('Ошибка экспорта', 'error');
    }
}

async function exportJSON() {
    try {
        const response = await axios.get('/api/export/json');
        downloadFile(JSON.stringify(response.data, null, 2), 'docker-network.json', 'application/json');
        showNotification('JSON экспортирован!');
    } catch (error) {
        showNotification('Ошибка экспорта', 'error');
    }
}

function downloadFile(content, filename, type) {
    const blob = new Blob([content], { type });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    window.URL.revokeObjectURL(url);
}


function showNotification(message, type = 'success') {
    console.log(`${type}: ${message}`);
}


function togglePhysics() {
    physicsEnabled = !physicsEnabled;
    network.setOptions({ physics: { enabled: physicsEnabled } });
}


function connectWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;
    
    ws = new WebSocket(wsUrl);
    
    ws.onopen = () => updateConnectionStatus(true);
    ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        dockerAvailable = data.docker_available !== false;
        updateUIForDockerStatus();
        
        if (dockerAvailable && !data.error) {
            updateVisualization(data);
            updateSummary(data.summary);
            updateContainerList(data.containers);
            hideNoDataOverlay();
        }
    };
    ws.onclose = () => {
        updateConnectionStatus(false);
        setTimeout(connectWebSocket, 5000);
    };
    ws.onerror = () => updateConnectionStatus(false);
}


function updateConnectionStatus(connected) {
    const statusElement = document.getElementById('connectionStatus');
    if (statusElement) {
        const indicator = statusElement.querySelector('.status-indicator');
        const text = statusElement.querySelector('.status-text');
        indicator.className = `status-indicator ${connected ? 'connected' : ''}`;
        text.textContent = connected ? 'Подключено' : 'Отключено';
    }
}


function showHelp() {
    document.getElementById('helpModal')?.classList.add('show');
}


function closeHelp() {
    document.getElementById('helpModal')?.classList.remove('show');
}


function setView(view) {
    document.querySelectorAll('.view-btn').forEach(btn => btn.classList.remove('active'));
    event.target.classList.add('active');
}


setInterval(() => dockerAvailable && loadData(), 30000);

window.dockerMapper = { reload: loadData, togglePhysics, exportData: exportJSON };

console.log('🐳 Docker Network Mapper запущен!');