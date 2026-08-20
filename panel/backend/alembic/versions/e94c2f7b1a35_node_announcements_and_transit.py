"""node announcements and the transit tunnel

Revision ID: e94c2f7b1a35
Revises: d51e7a20c884
Create Date: 2026-08-20 15:02:51.664120

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'e94c2f7b1a35'
down_revision: Union[str, Sequence[str], None] = 'd51e7a20c884'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

APPROVAL = sa.Enum('pending', 'approved', 'rejected', name='node_approval')


def upgrade() -> None:
    """Upgrade schema."""
    # add_column does not create the type itself.
    APPROVAL.create(op.get_bind(), checkfirst=True)

    op.add_column('nodes', sa.Column('is_hub', sa.Boolean(), nullable=False, server_default=sa.false()))
    op.add_column('nodes', sa.Column('approval', APPROVAL, nullable=False, server_default='approved'))
    op.add_column('nodes', sa.Column('approved_at', sa.DateTime(timezone=True), nullable=True))
    op.add_column('nodes', sa.Column('approved_by_id', sa.Uuid(), nullable=True))
    op.add_column('nodes', sa.Column('hostname', sa.String(length=255), nullable=True))
    op.add_column('nodes', sa.Column('announce_ip', sa.String(length=45), nullable=True))
    op.add_column('nodes', sa.Column('wan_iface', sa.String(length=32), nullable=True))
    op.add_column('nodes', sa.Column('subnets', sa.JSON(), nullable=True))
    op.add_column('nodes', sa.Column('key_fingerprint', sa.String(length=95), nullable=True))
    op.add_column('nodes', sa.Column('announce_csr_pem', sa.Text(), nullable=True))
    op.add_column('nodes', sa.Column('agent_cert_pem', sa.Text(), nullable=True))
    op.add_column('nodes', sa.Column('transit_host', sa.Integer(), nullable=True))
    op.add_column('nodes', sa.Column('announce_token_hash', sa.String(length=64), nullable=True))

    op.create_foreign_key(
        'fk_nodes_approved_by', 'nodes', 'users', ['approved_by_id'], ['id'], ondelete='SET NULL'
    )
    op.create_unique_constraint('uq_nodes_transit_host', 'nodes', ['transit_host'])
    op.create_index(op.f('ix_nodes_key_fingerprint'), 'nodes', ['key_fingerprint'])
    op.create_index(op.f('ix_nodes_announce_token_hash'), 'nodes', ['announce_token_hash'])

    # Nodes that already exist were added by an operator by hand, so they are
    # approved by definition; the default above covers them. New rows come from
    # announcements and the model sets `pending` explicitly.
    op.alter_column('nodes', 'approval', server_default=None)
    op.alter_column('nodes', 'is_hub', server_default=None)


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index(op.f('ix_nodes_announce_token_hash'), table_name='nodes')
    op.drop_index(op.f('ix_nodes_key_fingerprint'), table_name='nodes')
    op.drop_constraint('uq_nodes_transit_host', 'nodes', type_='unique')
    op.drop_constraint('fk_nodes_approved_by', 'nodes', type_='foreignkey')
    for column in (
        'announce_token_hash', 'transit_host', 'agent_cert_pem', 'announce_csr_pem',
        'key_fingerprint', 'subnets', 'wan_iface', 'announce_ip', 'hostname',
        'approved_by_id', 'approved_at', 'approval', 'is_hub',
    ):
        op.drop_column('nodes', column)
    APPROVAL.drop(op.get_bind(), checkfirst=True)
