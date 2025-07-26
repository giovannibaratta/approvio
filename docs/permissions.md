# Permissions System

The permissions system controls access to resources and operations through a combination of organizational roles, group memberships, and role-based permissions.

## Core Concepts

### User Roles

Users have organizational-level roles that provide system-wide permissions:

- **Admin**: Full system access, can manage all groups and users
- **Member**: Standard user with limited permissions

### Group Membership Roles

Within groups, users have specific roles that determine their permissions:

- **OWNER**: Full group control, can manage all aspects of the group
- **ADMIN**: Group administration, can manage memberships and settings
- **APPROVER**: Can vote on workflows requiring the group's approval
- **AUDITOR**: Read-only access to group information and workflows

## Workflow Permissions

### Voting Rights

Users can vote on workflows if they meet all conditions:

- **Group Membership**: Must belong to a group referenced in the workflow's approval rules
- **Role Requirement**: Must have APPROVER, ADMIN, or OWNER role in that group
- **Template Status**: The workflow template must allow voting (active or deprecated with voting enabled)

## Security Considerations

### Vote Integrity

- Vote permissions are validated at vote time, not workflow creation time
- Template changes don't affect existing workflow voting permissions
