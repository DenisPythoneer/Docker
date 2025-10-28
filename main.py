#!/usr/bin/env python3

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from contextlib import asynccontextmanager
from collections import defaultdict
from datetime import datetime
import asyncio
import uvicorn
import docker
import os


mapper = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global mapper
    mapper = DockerNetworkMapper()
    asyncio.create_task(background_monitor())
    yield
    if mapper:
        mapper.connections.clear()


app = FastAPI(lifespan=lifespan)


class DockerNetworkMapper:
    def __init__(self):
        self.client = None
        self.data = defaultdict(dict)
        self.connections = []
        self.ws_connections = []
        self.docker_available = False
        self.init_docker()
    
    
    def init_docker(self):
        try:
            self.client = docker.from_env()
            self.client.ping()
            self.docker_available = True
            print("✅ Docker connected")
        except:
            self.docker_available = False
            print("❌ Docker not available")
    
    
    async def get_network_data(self):
        if not self.docker_available:
            return self.error_data("Docker not available")
        
        try:
            containers = self.client.containers.list(all=True)
            self.data.clear()
            
            for container in containers:
                container_id = container.id[:12]
                networks = container.attrs.get('NetworkSettings', {}).get('Networks', {})
                
                self.data[container_id] = {
                    'id': container_id,
                    'name': container.name,
                    'networks': {net: data.get('IPAddress', 'N/A') for net, data in networks.items()},
                    'status': container.status,
                    'image': container.image.tags[0] if container.image.tags else 'unknown',
                    'stats': await self.get_stats(container_id),
                    'timestamp': datetime.now().isoformat()
                }
            
            self.detect_connections()
            
            return {
                'containers': dict(self.data),
                'connections': self.connections,
                'timestamp': datetime.now().isoformat(),
                'summary': self.get_summary(),
                'docker_available': self.docker_available
            }
            
        except Exception as e:
            return self.error_data(str(e))
    

    async def get_stats(self, container_id):
        if not self.docker_available:
            return {'error': 'Docker unavailable'}
        
        try:
            container = self.client.containers.get(container_id)
            stats = container.stats(stream=False)
            
            networks = stats.get('networks', {})
            network_stats = {
                iface: {
                    'rx_bytes': data.get('rx_bytes', 0),
                    'tx_bytes': data.get('tx_bytes', 0)
                } for iface, data in networks.items()
            }
            
            return {
                'cpu_percent': self.calc_cpu(stats),
                'memory_usage': stats.get('memory_stats', {}).get('usage', 0),
                'network': network_stats
            }
        except:
            return {'error': 'Stats unavailable'}
    

    def calc_cpu(self, stats):
        try:
            cpu_stats = stats.get('cpu_stats', {})
            precpu_stats = stats.get('precpu_stats', {})
            
            cpu_delta = cpu_stats.get('cpu_usage', {}).get('total_usage', 0) - \
                       precpu_stats.get('cpu_usage', {}).get('total_usage', 0)
            system_delta = cpu_stats.get('system_cpu_usage', 0) - \
                          precpu_stats.get('system_cpu_usage', 0)
            
            return (cpu_delta / system_delta) * 100.0 if system_delta > 0 else 0.0
        except:
            return 0.0
    

    def detect_connections(self):
        self.connections.clear()
        network_containers = defaultdict(list)
        
        for container_id, data in self.data.items():
            for network in data.get('networks', {}):
                if network != 'N/A':
                    network_containers[network].append(container_id)
        
        for network, containers in network_containers.items():
            if len(containers) > 1:
                for i, c1 in enumerate(containers):
                    for c2 in containers[i+1:]:
                        self.connections.append({
                            'id': f"{c1}-{c2}-{network}",
                            'source': c1, 'target': c2, 'network': network
                        })
    

    def get_summary(self):
        if not self.docker_available:
            return {'total_containers': 0, 'running_containers': 0, 'total_networks': 0, 'total_connections': 0}
        
        running = sum(1 for data in self.data.values() if data.get('status') == 'running')
        networks = len(set(n for data in self.data.values() for n in data.get('networks', {}) if n != 'N/A'))
        
        return {
            'total_containers': len(self.data),
            'running_containers': running,
            'total_networks': networks,
            'total_connections': len(self.connections)
        }
    

    def error_data(self, error):
        return {
            'error': error,
            'containers': {},
            'connections': [],
            'timestamp': datetime.now().isoformat(),
            'summary': self.get_summary(),
            'docker_available': self.docker_available
        }
    

    def generate_plantuml(self):
        if not self.docker_available:
            return "@startuml\nnote\n Docker unavailable\nend note\n@enduml"
        
        lines = ["@startuml", "skinparam monochrome true", "title Docker Network", ""]
        
        for cid, data in self.data.items():
            status = "🟢" if data.get('status') == 'running' else "🔴"
            lines.append(f'component "{status} {data["name"]}" as {cid}')
        
        lines.append("")
        for conn in self.connections:
            lines.append(f'{conn["source"]} --> {conn["target"]} : {conn["network"]}')
        
        lines.append("@enduml")
        return "\n".join(lines)
    

    async def broadcast(self):
        if not self.ws_connections:
            return
        
        data = await self.get_network_data()
        for ws in self.ws_connections[:]:
            try:
                await ws.send_json(data)
            except:
                self.ws_connections.remove(ws)


@app.get("/")
async def root():
    return FileResponse("static/index.html")


@app.get("/api/network-data")
async def network_data():
    return await mapper.get_network_data() if mapper else {"error": "Not ready"}


@app.get("/api/plantuml")
async def plantuml():
    return {"plantuml": mapper.generate_plantuml() if mapper else "@startuml\nnote\n Not ready\nend note\n@enduml"}


@app.get("/api/export/json")
async def export_json():
    return await mapper.get_network_data() if mapper else {"error": "Not ready"}


@app.websocket("/ws")
async def websocket(ws: WebSocket):
    await ws.accept()
    if mapper:
        mapper.ws_connections.append(ws)
    
    try:
        if mapper:
            await ws.send_json(await mapper.get_network_data())
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        if mapper and ws in mapper.ws_connections:
            mapper.ws_connections.remove(ws)


async def background_monitor():
    while True:
        try:
            if mapper:
                await mapper.broadcast()
            await asyncio.sleep(10)
        except:
            await asyncio.sleep(5)


app.mount("/static", StaticFiles(directory="static"), name="static")


if __name__ == "__main__":
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)