"""Loopback-only Monitor SSO fixture: real routes/templates, synthetic users and database."""
import argparse
import json
import os
import sys
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--repo', required=True)
parser.add_argument('--keys', required=True)
# Team Control's redeem endpoint, served by the test process on loopback. The Monitor calls it server to server.
parser.add_argument('--team-control', required=True)
args = parser.parse_args()
sys.path.insert(0, args.repo)
os.environ['AIONE_SSO_ENABLED'] = 'true'
os.environ['AIONE_SSO_PUBLIC_KEYS_DIR'] = args.keys
os.environ['MONITOR_PUBLIC_ORIGIN'] = 'https://monitor.ai1.host'
os.environ['AIONE_DASHBOARD_ORIGIN'] = 'https://dashboard.ai1.host'
os.environ['AIONE_TEAM_CONTROL_URL'] = args.team_control

from flask import Flask, jsonify, request, session
from flask_login import LoginManager, UserMixin, current_user, logout_user
from werkzeug.serving import make_server
from standalone_dashboard import register_standalone_dashboard
from response_security import apply_response_security

SUBJECTS = {1: 'e2e-alice-00000000001', 2: 'e2e-bob-0000000000002'}

class User(UserMixin):
    auth_provider = 'native'
    session_version = 1
    is_native_user = True
    is_odoo_user = False
    is_administrator = True
    is_infrastructure_operator = True
    is_internal = True
    is_portal = False
    monitor_role = 'administrator'
    odoo_login = None
    def __init__(self, uid):
        self.id = uid
        self.display_name = 'Alice' if uid == 1 else 'Bob'
        self.username = self.display_name.lower()
        self.email = self.username + '@example.invalid'
        self.identity_uuid = 'e2e-monitor-user-' + str(uid)
    def get_id(self):
        return str(self.id) + ':1'
    @staticmethod
    def get(key):
        try:
            uid = int(str(key).split(':')[0])
            return User(uid) if uid in SUBJECTS else None
        except (ValueError, TypeError):
            return None

class Database:
    def __init__(self):
        self.replays = set()
        self.events = []
    def connection(self):
        return Connection(self)
class Connection:
    def __init__(self, db): self.db = db
    def cursor(self): return Cursor(self.db)
    def commit(self): pass
    def rollback(self): pass
    def close(self): pass
class Cursor:
    def __init__(self, db):
        self.db = db
        self.rowcount = 0
        self.rows = []
    def execute(self, sql, params=None):
        self.rows = []
        if 'INSERT INTO aione_sso_replays' in sql:
            self.rowcount = 0 if params[0] in self.db.replays else 1
            self.db.replays.add(params[0])
        elif 'FROM aione_identity_links' in sql:
            self.rows = [(uid, 'native', 1, 'active') for uid, sub in SUBJECTS.items() if sub == params[0]]
        elif 'monitor_auth_events' in sql:
            self.db.events.append(params)
    def fetchall(self): return self.rows
    def fetchone(self): return self.rows[0] if self.rows else None
    def close(self): pass

db = Database()
app = Flask(__name__, template_folder=str(Path(args.repo) / 'templates'), static_folder=str(Path(args.repo) / 'static'))
app.secret_key = os.urandom(32)
app.config.update(SESSION_COOKIE_SECURE=True, SESSION_COOKIE_HTTPONLY=True, SESSION_COOKIE_SAMESITE='Lax')
manager = LoginManager(app)
manager.login_view = 'login'
manager.user_loader(User.get)
@app.route('/login')
def login(): return 'Direct Monitor sign-in', 200
@app.route('/logout')
def logout():
    logout_user()
    session.clear()
    return 'Signed out'
register_standalone_dashboard(app, User, db.connection)
app.after_request(lambda response: apply_response_security(response, request))

# Only peripheral data is stubbed. Token verification, replay protection, identity lookup,
# session creation/expiry, security headers, templates, and browser JS are the repository code.
@app.before_request
def peripheral_data():
    if request.path.startswith('/api/') and request.path != '/api/session':
        if not current_user.is_authenticated:
            return manager.unauthorized()
        fixtures = {
            '/api/admin/users': {'users': []},
            '/api/monitor/activity': {'actions': []},
            '/api/account/connections': {'connections': []},
            '/api/account/mfa': {'enabled': False, 'recovery_codes_remaining': 0},
            '/api/auth/providers': {'providers': [], 'native_auth_enabled': False},
        }
        return jsonify(success=True, **fixtures.get(request.path, {}))
@app.post('/__test/expire')
def expire():
    session['aione_session_expires_at'] = 1
    return jsonify(success=True)

server = make_server('127.0.0.1', 0, app)
print(json.dumps({'port': server.server_port}), flush=True)
server.serve_forever()
