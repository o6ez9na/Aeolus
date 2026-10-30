"""client groups as roles, and grants limited to part of a node's LAN

Revision ID: d4a8c2e6f913
Revises: c9e1f4a7b302
Create Date: 2026-10-29 15:00:00.000000

Groups used to live in the map layout and only copied their access onto a
client once, when it was dropped in. They become rows here, and the groups
already drawn on the map are carried over with their members and access.
"""
import json
import uuid
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'd4a8c2e6f913'
down_revision: Union[str, Sequence[str], None] = 'c9e1f4a7b302'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        'client_groups',
        sa.Column('name', sa.String(length=64), nullable=False),
        sa.Column('id', sa.Uuid(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('name'),
    )
    op.create_table(
        'client_group_grants',
        sa.Column('group_id', sa.Uuid(), nullable=False),
        sa.Column('node_id', sa.Uuid(), nullable=False),
        sa.Column('is_exit', sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column('networks', sa.JSON(), nullable=True),
        sa.Column('id', sa.Uuid(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.ForeignKeyConstraint(['group_id'], ['client_groups.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['node_id'], ['nodes.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('group_id', 'node_id', name='uq_group_node'),
    )
    op.create_index(op.f('ix_client_group_grants_group_id'), 'client_group_grants', ['group_id'])
    op.create_index(op.f('ix_client_group_grants_node_id'), 'client_group_grants', ['node_id'])

    op.add_column('clients', sa.Column('group_id', sa.Uuid(), nullable=True))
    op.create_index(op.f('ix_clients_group_id'), 'clients', ['group_id'])
    op.create_foreign_key(
        'fk_clients_group_id', 'clients', 'client_groups', ['group_id'], ['id'], ondelete='SET NULL'
    )

    op.add_column('client_node_grants', sa.Column('networks', sa.JSON(), nullable=True))
    op.add_column('client_node_grants', sa.Column('group_id', sa.Uuid(), nullable=True))
    op.create_index(op.f('ix_client_node_grants_group_id'), 'client_node_grants', ['group_id'])
    op.create_foreign_key(
        'fk_client_node_grants_group_id',
        'client_node_grants',
        'client_groups',
        ['group_id'],
        ['id'],
        ondelete='CASCADE',
    )

    _carry_over_map_groups()


def _carry_over_map_groups() -> None:
    bind = op.get_bind()
    row = bind.execute(sa.text("SELECT data FROM ui_layouts WHERE key = 'map'")).first()
    if row is None:
        return
    data = row[0]
    if isinstance(data, str):
        data = json.loads(data)
    groups = (data or {}).get('groups') or []
    if not groups:
        return

    clients = {str(r[0]) for r in bind.execute(sa.text('SELECT id FROM clients'))}
    nodes = {str(r[0]) for r in bind.execute(sa.text('SELECT id FROM nodes'))}
    positions = dict((data or {}).get('positions') or {})
    taken_names: set[str] = set()
    assigned: set[str] = set()

    for group in groups:
        name = (group.get('name') or 'Группа').strip()[:60] or 'Группа'
        base, n = name, 2
        while name in taken_names:
            name = f'{base} {n}'
            n += 1
        taken_names.add(name)

        group_id = uuid.uuid4()
        bind.execute(
            sa.text('INSERT INTO client_groups (id, name) VALUES (:id, :name)'),
            {'id': group_id, 'name': name},
        )
        exit_node = group.get('exit_node_id')
        node_ids = [n for n in dict.fromkeys(group.get('node_ids') or []) if n in nodes]
        if exit_node in nodes and exit_node not in node_ids:
            node_ids.append(exit_node)
        for node_id in node_ids:
            bind.execute(
                sa.text(
                    'INSERT INTO client_group_grants (id, group_id, node_id, is_exit) '
                    'VALUES (:id, :group_id, :node_id, :is_exit)'
                ),
                {
                    'id': uuid.uuid4(),
                    'group_id': group_id,
                    'node_id': uuid.UUID(node_id),
                    'is_exit': node_id == exit_node,
                },
            )

        for member in group.get('members') or []:
            if member not in clients or member in assigned:
                continue
            assigned.add(member)
            bind.execute(
                sa.text('UPDATE clients SET group_id = :g WHERE id = :c'),
                {'g': group_id, 'c': uuid.UUID(member)},
            )
            # The old map copied the group's access onto its members, so those
            # grants already exist; from now on the group owns them.
            for node_id in node_ids:
                bind.execute(
                    sa.text(
                        'UPDATE client_node_grants SET group_id = :g '
                        'WHERE client_id = :c AND node_id = :n'
                    ),
                    {'g': group_id, 'c': uuid.UUID(member), 'n': uuid.UUID(node_id)},
                )

        if 'x' in group and 'y' in group:
            positions[f'group:{group_id}'] = {'x': group['x'], 'y': group['y']}

    bind.execute(
        sa.text("UPDATE ui_layouts SET data = CAST(:data AS json) WHERE key = 'map'"),
        {'data': json.dumps({'positions': positions})},
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_constraint('fk_client_node_grants_group_id', 'client_node_grants', type_='foreignkey')
    op.drop_index(op.f('ix_client_node_grants_group_id'), table_name='client_node_grants')
    op.drop_column('client_node_grants', 'group_id')
    op.drop_column('client_node_grants', 'networks')
    op.drop_constraint('fk_clients_group_id', 'clients', type_='foreignkey')
    op.drop_index(op.f('ix_clients_group_id'), table_name='clients')
    op.drop_column('clients', 'group_id')
    op.drop_index(op.f('ix_client_group_grants_node_id'), table_name='client_group_grants')
    op.drop_index(op.f('ix_client_group_grants_group_id'), table_name='client_group_grants')
    op.drop_table('client_group_grants')
    op.drop_table('client_groups')
