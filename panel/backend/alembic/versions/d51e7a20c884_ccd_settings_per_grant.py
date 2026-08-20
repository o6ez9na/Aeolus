"""ccd settings per client-node grant

Revision ID: d51e7a20c884
Revises: c3f8b1a54d17
Create Date: 2026-08-20 13:18:44.201773

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'd51e7a20c884'
down_revision: Union[str, Sequence[str], None] = 'c3f8b1a54d17'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column('client_node_grants', sa.Column('static_host', sa.Integer(), nullable=True))
    op.add_column('client_node_grants', sa.Column('push_routes', sa.JSON(), nullable=True))
    op.add_column('client_node_grants', sa.Column('iroutes', sa.JSON(), nullable=True))
    op.add_column('client_node_grants', sa.Column('push_options', sa.JSON(), nullable=True))
    # Partial: only pinned clients compete for an address.
    op.create_index(
        'uq_node_static_host',
        'client_node_grants',
        ['node_id', 'static_host'],
        unique=True,
        postgresql_where=sa.text('static_host IS NOT NULL'),
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index('uq_node_static_host', table_name='client_node_grants')
    op.drop_column('client_node_grants', 'push_options')
    op.drop_column('client_node_grants', 'iroutes')
    op.drop_column('client_node_grants', 'push_routes')
    op.drop_column('client_node_grants', 'static_host')
