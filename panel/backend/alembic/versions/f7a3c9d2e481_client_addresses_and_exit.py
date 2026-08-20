"""client tunnel addresses and the per-grant exit

Revision ID: f7a3c9d2e481
Revises: e94c2f7b1a35
Create Date: 2026-08-20 12:40:11.028415

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'f7a3c9d2e481'
down_revision: Union[str, Sequence[str], None] = 'e94c2f7b1a35'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column('clients', sa.Column('tunnel_host', sa.Integer(), nullable=True))
    op.create_unique_constraint('uq_clients_tunnel_host', 'clients', ['tunnel_host'])
    op.add_column(
        'client_node_grants',
        sa.Column('is_exit', sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    op.alter_column('client_node_grants', 'is_exit', server_default=None)
    # Addresses for existing clients are handed out at startup rather than here:
    # the range they come from is application configuration, not schema.


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column('client_node_grants', 'is_exit')
    op.drop_constraint('uq_clients_tunnel_host', 'clients', type_='unique')
    op.drop_column('clients', 'tunnel_host')
