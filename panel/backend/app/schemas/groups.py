import uuid

from pydantic import BaseModel, Field


class GroupGrantIn(BaseModel):
    node_id: uuid.UUID
    is_exit: bool = False
    # Only part of the node's LAN: subnets of it or single addresses. Null for
    # everything the node announces.
    networks: list[str] | None = Field(default=None, max_length=64)


class GroupGrantRead(BaseModel):
    node_id: uuid.UUID
    node_name: str
    node_is_hub: bool = False
    node_subnets: list[str] = []
    is_exit: bool = False
    networks: list[str] | None = None


class GroupRead(BaseModel):
    id: uuid.UUID
    name: str
    member_ids: list[uuid.UUID] = []
    grants: list[GroupGrantRead] = []


class GroupCreate(BaseModel):
    name: str = Field(min_length=1, max_length=64)
    grants: list[GroupGrantIn] = Field(default_factory=list, max_length=200)


class GroupUpdate(BaseModel):
    name: str = Field(min_length=1, max_length=64)


class GroupGrantsUpdate(BaseModel):
    grants: list[GroupGrantIn] = Field(max_length=200)
