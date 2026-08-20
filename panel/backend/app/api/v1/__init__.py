from fastapi import APIRouter

from app.api.v1 import agents, audit, auth, ccd, clients, nodes, pki, users

api_router = APIRouter()
api_router.include_router(auth.router)
api_router.include_router(users.router)
api_router.include_router(nodes.router)
api_router.include_router(clients.router)
api_router.include_router(pki.router)
api_router.include_router(agents.router)
api_router.include_router(audit.router)
api_router.include_router(ccd.router)
