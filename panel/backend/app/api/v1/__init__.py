from fastapi import APIRouter

from app.api.v1 import agents, audit, auth, ccd, clients, groups, nodes, pki, ui, users

api_router = APIRouter()
api_router.include_router(auth.router)
api_router.include_router(users.router)
api_router.include_router(nodes.router)
api_router.include_router(clients.router)
api_router.include_router(pki.router)
api_router.include_router(agents.router)
api_router.include_router(audit.router)
api_router.include_router(ccd.router)
api_router.include_router(groups.router)
api_router.include_router(ui.router)
