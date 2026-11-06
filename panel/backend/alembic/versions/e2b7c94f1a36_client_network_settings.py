"""Move a client's network settings from the client-node pair to the client

Clients dial only the hub and get one file there, so only the row for the hub
ever reached it: settings on any other row were stored and ignored. static_host
never did anything on the hub, where Client.tunnel_host wins, and is not kept.

Revision ID: e2b7c94f1a36
Revises: c5f1e8a3d6b2
Create Date: 2026-11-07 03:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'e2b7c94f1a36'
down_revision: Union[str, Sequence[str], None] = 'c5f1e8a3d6b2'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('clients', sa.Column('push_routes', sa.JSON(), nullable=True))
    op.add_column('clients', sa.Column('iroutes', sa.JSON(), nullable=True))
    op.add_column('clients', sa.Column('push_options', sa.JSON(), nullable=True))
    op.add_column('clients', sa.Column('dns_servers', sa.JSON(), nullable=True))
    op.execute(
        """
        UPDATE clients AS c
        SET push_routes = g.push_routes, iroutes = g.iroutes, push_options = g.push_options
        FROM client_node_grants AS g
        JOIN nodes AS n ON n.id = g.node_id
        WHERE g.client_id = c.id AND n.is_hub
        """
    )
    op.drop_index('uq_node_static_host', table_name='client_node_grants')
    op.drop_column('client_node_grants', 'push_options')
    op.drop_column('client_node_grants', 'iroutes')
    op.drop_column('client_node_grants', 'push_routes')
    op.drop_column('client_node_grants', 'static_host')


def downgrade() -> None:
    op.add_column('client_node_grants', sa.Column('static_host', sa.Integer(), nullable=True))
    op.add_column('client_node_grants', sa.Column('push_routes', sa.JSON(), nullable=True))
    op.add_column('client_node_grants', sa.Column('iroutes', sa.JSON(), nullable=True))
    op.add_column('client_node_grants', sa.Column('push_options', sa.JSON(), nullable=True))
    op.create_index(
        'uq_node_static_host',
        'client_node_grants',
        ['node_id', 'static_host'],
        unique=True,
        postgresql_where=sa.text('static_host IS NOT NULL'),
    )
    op.execute(
        """
        UPDATE client_node_grants AS g
        SET push_routes = c.push_routes, iroutes = c.iroutes, push_options = c.push_options
        FROM clients AS c, nodes AS n
        WHERE g.client_id = c.id AND n.id = g.node_id AND n.is_hub
        """
    )
    op.drop_column('clients', 'dns_servers')
    op.drop_column('clients', 'push_options')
    op.drop_column('clients', 'iroutes')
    op.drop_column('clients', 'push_routes')
