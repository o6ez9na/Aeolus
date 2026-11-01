"""site links: networks of two nodes reach each other over the transit

Revision ID: b8e3d1f6a947
Revises: a3d5f7b9c1e2
Create Date: 2026-11-01 18:30:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'b8e3d1f6a947'
down_revision: Union[str, Sequence[str], None] = 'a3d5f7b9c1e2'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column('nodes', sa.Column('site_subnets', sa.JSON(), nullable=True))
    op.create_table(
        'node_links',
        sa.Column('node_a_id', sa.Uuid(), nullable=False),
        sa.Column('node_b_id', sa.Uuid(), nullable=False),
        sa.Column('id', sa.Uuid(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.ForeignKeyConstraint(['node_a_id'], ['nodes.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['node_b_id'], ['nodes.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('node_a_id', 'node_b_id', name='uq_node_link'),
        sa.CheckConstraint('node_a_id < node_b_id', name='ck_node_link_ordered'),
    )
    op.create_index(op.f('ix_node_links_node_a_id'), 'node_links', ['node_a_id'])
    op.create_index(op.f('ix_node_links_node_b_id'), 'node_links', ['node_b_id'])


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index(op.f('ix_node_links_node_b_id'), table_name='node_links')
    op.drop_index(op.f('ix_node_links_node_a_id'), table_name='node_links')
    op.drop_table('node_links')
    op.drop_column('nodes', 'site_subnets')
