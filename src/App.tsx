import React, { useState, useEffect } from 'react';
import { 
  Server, 
  ShieldCheck, 
  Key, 
  Terminal, 
  CheckCircle2, 
  AlertCircle, 
  FileText, 
  Smartphone, 
  Copy, 
  Check, 
  RefreshCw, 
  FolderLock, 
  Database,
  Code2
} from 'lucide-react';

interface HealthData {
  status: string;
  uptimeSeconds: number;
  timestamp: string;
  environment: string;
  service: string;
  version: string;
  firebase: {
    initialized: boolean;
    projectId: string;
    authMethod: string;
    message: string;
  };
  endpoints: Record<string, string>;
}

export default function App() {
  const [activeTab, setActiveTab] = useState<'status' | 'endpoints' | 'android' | 'config'>('status');
  const [health, setHealth] = useState<HealthData | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [testEndpoint, setTestEndpoint] = useState<string>('/api/health');
  const [tokenInput, setTokenInput] = useState<string>('');
  const [testResponse, setTestResponse] = useState<string>('');
  const [testStatus, setTestStatus] = useState<number | null>(null);
  const [copiedSnippet, setCopiedSnippet] = useState<string | null>(null);

  const fetchHealth = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/health');
      const data = await res.json();
      if (data.success) {
        setHealth(data.data);
      }
    } catch (err) {
      console.error('Failed to fetch health status', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchHealth();
  }, []);

  const handleRunTest = async () => {
    setLoading(true);
    setTestResponse('Executing request...');
    setTestStatus(null);
    try {
      const headers: Record<string, string> = {
        'Accept': 'application/json'
      };
      if (tokenInput.trim()) {
        headers['Authorization'] = `Bearer ${tokenInput.trim()}`;
      }

      let res: Response;
      if (testEndpoint === '/api/documents/upload') {
        headers['Content-Type'] = 'application/json';
        res = await fetch(testEndpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify({ fileName: 'sample_document.pdf' })
        });
      } else {
        res = await fetch(testEndpoint, {
          method: 'GET',
          headers
        });
      }

      setTestStatus(res.status);
      const json = await res.json();
      setTestResponse(JSON.stringify(json, null, 2));
    } catch (err) {
      setTestStatus(500);
      setTestResponse(JSON.stringify({ error: 'Request failed', message: String(err) }, null, 2));
    } finally {
      setLoading(false);
    }
  };

  const copyToClipboard = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedSnippet(id);
    setTimeout(() => setCopiedSnippet(null), 2000);
  };

  const androidCodeSnippet = `// 1. Authenticate with Firebase Auth on Android
val auth = FirebaseAuth.getInstance()
val currentUser = auth.currentUser

// 2. Retrieve the Firebase ID Token
currentUser?.getIdToken(true)?.addOnCompleteListener { task ->
    if (task.isSuccessful) {
        val idToken = task.result?.token ?: return@addOnCompleteListener
        
        // 3. Make HTTP request with Authorization Header
        val client = OkHttpClient()
        val request = Request.Builder()
            .url("https://<YOUR_BACKEND_URL>/api/profile")
            .addHeader("Authorization", "Bearer $idToken")
            .addHeader("Accept", "application/json")
            .build()
            
        client.newCall(request).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                Log.e("API", "Request failed", e)
            }
            override fun onResponse(call: Call, response: Response) {
                val responseBody = response.body?.string()
                Log.d("API", "Client Profile: $responseBody")
            }
        })
    }
}`;

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100 font-sans antialiased">
      {/* Top Navbar */}
      <header className="border-b border-neutral-800 bg-neutral-900/80 backdrop-blur-md sticky top-0 z-50">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center text-emerald-400">
              <Server className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-base font-semibold text-neutral-100 tracking-tight">Backend API Service</h1>
                <span className="text-[11px] font-mono px-2 py-0.5 rounded-full bg-neutral-800 text-neutral-400 border border-neutral-700">
                  Node.js / Express
                </span>
              </div>
              <p className="text-xs text-neutral-400">Connected to Existing Firebase Project & Android Client</p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-md bg-neutral-800/80 border border-neutral-700/60 text-xs">
              <span className={`w-2 h-2 rounded-full ${health?.status === 'healthy' ? 'bg-emerald-400 animate-pulse' : 'bg-amber-400'}`} />
              <span className="text-neutral-300 font-mono">
                Port 3000 • {health?.environment || 'development'}
              </span>
            </div>
            <button
              onClick={fetchHealth}
              disabled={loading}
              id="refresh-health-button"
              className="p-2 rounded-md hover:bg-neutral-800 text-neutral-400 hover:text-neutral-200 transition-colors"
              title="Refresh API Status"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            </button>
          </div>
        </div>
      </header>

      {/* Main Container */}
      <main className="max-w-6xl mx-auto px-4 sm:px-6 py-8">
        {/* Navigation Tabs */}
        <nav className="flex space-x-1 border-b border-neutral-800 mb-8" aria-label="Tabs">
          <button
            onClick={() => setActiveTab('status')}
            id="tab-status"
            className={`pb-3 px-4 text-sm font-medium border-b-2 transition-colors flex items-center gap-2 ${
              activeTab === 'status'
                ? 'border-emerald-400 text-emerald-400'
                : 'border-transparent text-neutral-400 hover:text-neutral-200 hover:border-neutral-700'
            }`}
          >
            <Server className="w-4 h-4" />
            Live Status & Health
          </button>
          <button
            onClick={() => setActiveTab('endpoints')}
            id="tab-endpoints"
            className={`pb-3 px-4 text-sm font-medium border-b-2 transition-colors flex items-center gap-2 ${
              activeTab === 'endpoints'
                ? 'border-emerald-400 text-emerald-400'
                : 'border-transparent text-neutral-400 hover:text-neutral-200 hover:border-neutral-700'
            }`}
          >
            <Terminal className="w-4 h-4" />
            API Console & Endpoints
          </button>
          <button
            onClick={() => setActiveTab('android')}
            id="tab-android"
            className={`pb-3 px-4 text-sm font-medium border-b-2 transition-colors flex items-center gap-2 ${
              activeTab === 'android'
                ? 'border-emerald-400 text-emerald-400'
                : 'border-transparent text-neutral-400 hover:text-neutral-200 hover:border-neutral-700'
            }`}
          >
            <Smartphone className="w-4 h-4" />
            Android Integration & Security
          </button>
          <button
            onClick={() => setActiveTab('config')}
            id="tab-config"
            className={`pb-3 px-4 text-sm font-medium border-b-2 transition-colors flex items-center gap-2 ${
              activeTab === 'config'
                ? 'border-emerald-400 text-emerald-400'
                : 'border-transparent text-neutral-400 hover:text-neutral-200 hover:border-neutral-700'
            }`}
          >
            <Key className="w-4 h-4" />
            Credentials Setup Guide
          </button>
        </nav>

        {/* Tab 1: Status & Architecture */}
        {activeTab === 'status' && (
          <div className="space-y-6">
            {/* Quick Metrics Grid */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-5">
                <div className="flex items-center justify-between text-neutral-400 mb-2">
                  <span className="text-xs font-medium uppercase tracking-wider">REST API Server</span>
                  <Server className="w-4 h-4 text-emerald-400" />
                </div>
                <div className="text-2xl font-bold text-neutral-100 flex items-center gap-2">
                  <span>Operational</span>
                  <span className="w-2.5 h-2.5 rounded-full bg-emerald-400 inline-block" />
                </div>
                <p className="text-xs text-neutral-400 mt-2">
                  Uptime: {health?.uptimeSeconds ? `${health.uptimeSeconds}s` : 'active'} • Version {health?.version || '1.0.0'}
                </p>
              </div>

              <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-5">
                <div className="flex items-center justify-between text-neutral-400 mb-2">
                  <span className="text-xs font-medium uppercase tracking-wider">Firebase Admin SDK</span>
                  <Database className="w-4 h-4 text-amber-400" />
                </div>
                <div className="text-xl font-bold text-neutral-100 truncate">
                  {health?.firebase?.initialized ? 'Connected' : 'Ready for Keys'}
                </div>
                <p className="text-xs text-neutral-400 mt-2 truncate">
                  {health?.firebase?.message || 'Awaiting Firebase credentials'}
                </p>
              </div>

              <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-5">
                <div className="flex items-center justify-between text-neutral-400 mb-2">
                  <span className="text-xs font-medium uppercase tracking-wider">Zero-Trust Model</span>
                  <ShieldCheck className="w-4 h-4 text-emerald-400" />
                </div>
                <div className="text-2xl font-bold text-neutral-100">Enforced</div>
                <p className="text-xs text-neutral-400 mt-2">
                  UID, PAN & Drive Folder locked to Firestore authority
                </p>
              </div>
            </div>

            {/* Architecture Overview Card */}
            <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-6">
              <h2 className="text-lg font-semibold text-neutral-100 mb-3 flex items-center gap-2">
                <ShieldCheck className="w-5 h-5 text-emerald-400" />
                Core Security & Modular Architecture
              </h2>
              <p className="text-sm text-neutral-300 leading-relaxed mb-6">
                This backend operates as an isolated server API for your existing Android application. 
                Per the project requirements, it shares the <strong>exact same Firebase project</strong> rather than creating a duplicate project, database, or auth realm.
              </p>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="p-4 rounded-lg bg-neutral-950 border border-neutral-800">
                  <div className="flex items-center gap-2 text-emerald-400 font-medium text-sm mb-1.5">
                    <CheckCircle2 className="w-4 h-4" />
                    Cryptographic Token Verification
                  </div>
                  <p className="text-xs text-neutral-400">
                    Android clients pass Firebase ID tokens via <code className="text-neutral-200 bg-neutral-900 px-1 py-0.5 rounded">Authorization: Bearer &lt;token&gt;</code>. 
                    The server verifies the cryptographic signature with Firebase Admin SDK to obtain the verified UID.
                  </p>
                </div>

                <div className="p-4 rounded-lg bg-neutral-950 border border-neutral-800">
                  <div className="flex items-center gap-2 text-emerald-400 font-medium text-sm mb-1.5">
                    <FolderLock className="w-4 h-4" />
                    Authoritative Drive Folder Enforcement
                  </div>
                  <p className="text-xs text-neutral-400">
                    Client requests are strictly forbidden from passing arbitrary Google Drive folder IDs, PAN numbers, or UIDs. 
                    The backend queries <code className="text-neutral-200 bg-neutral-900 px-1 py-0.5 rounded">users/{'{firebaseUid}'}</code> in Firestore to retrieve the client&apos;s authorized folder.
                  </p>
                </div>
              </div>
            </div>

            {/* Live Health Payload Box */}
            <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-6">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-semibold text-neutral-200 flex items-center gap-2">
                  <Code2 className="w-4 h-4 text-neutral-400" />
                  Live Response from <span className="text-emerald-400 font-mono">GET /api/health</span>
                </h3>
                <span className="text-xs text-neutral-400 font-mono">Status: 200 OK</span>
              </div>
              <pre className="bg-neutral-950 border border-neutral-800/80 rounded-lg p-4 font-mono text-xs text-emerald-400 overflow-x-auto">
                {JSON.stringify(health || { status: 'loading...' }, null, 2)}
              </pre>
            </div>
          </div>
        )}

        {/* Tab 2: Endpoints & Interactive Console */}
        {activeTab === 'endpoints' && (
          <div className="space-y-6">
            {/* Endpoints Table */}
            <div className="bg-neutral-900 border border-neutral-800 rounded-xl overflow-hidden">
              <div className="p-5 border-b border-neutral-800">
                <h2 className="text-base font-semibold text-neutral-100">Registered Backend Endpoints</h2>
                <p className="text-xs text-neutral-400 mt-1">
                  Ready to receive calls from your Android client application.
                </p>
              </div>

              <div className="divide-y divide-neutral-800 text-sm">
                <div className="p-4 flex items-center justify-between hover:bg-neutral-800/40 transition-colors">
                  <div className="flex items-center gap-3">
                    <span className="px-2 py-0.5 text-xs font-mono font-semibold rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                      GET
                    </span>
                    <span className="font-mono text-neutral-200">/api/health</span>
                  </div>
                  <div className="flex items-center gap-4 text-xs text-neutral-400">
                    <span>Public health check & Firebase status</span>
                    <button 
                      onClick={() => { setTestEndpoint('/api/health'); }}
                      className="text-emerald-400 hover:underline"
                    >
                      Load in Console
                    </button>
                  </div>
                </div>

                <div className="p-4 flex items-center justify-between hover:bg-neutral-800/40 transition-colors">
                  <div className="flex items-center gap-3">
                    <span className="px-2 py-0.5 text-xs font-mono font-semibold rounded bg-sky-500/10 text-sky-400 border border-sky-500/20">
                      GET
                    </span>
                    <span className="font-mono text-neutral-200">/api/health/firebase</span>
                  </div>
                  <div className="flex items-center gap-4 text-xs text-neutral-400">
                    <span className="flex items-center gap-1 text-amber-400">
                      <Key className="w-3 h-3" /> Requires Bearer Token (Tests Firestore)
                    </span>
                    <button 
                      onClick={() => { setTestEndpoint('/api/health/firebase'); }}
                      className="text-emerald-400 hover:underline"
                    >
                      Load in Console
                    </button>
                  </div>
                </div>

                <div className="p-4 flex items-center justify-between hover:bg-neutral-800/40 transition-colors">
                  <div className="flex items-center gap-3">
                    <span className="px-2 py-0.5 text-xs font-mono font-semibold rounded bg-sky-500/10 text-sky-400 border border-sky-500/20">
                      GET
                    </span>
                    <span className="font-mono text-neutral-200">/api/drive/test</span>
                  </div>
                  <div className="flex items-center gap-4 text-xs text-neutral-400">
                    <span className="flex items-center gap-1 text-amber-400">
                      <Key className="w-3 h-3" /> Requires Bearer Token (Drive Access Test)
                    </span>
                    <button 
                      onClick={() => { setTestEndpoint('/api/drive/test'); }}
                      className="text-emerald-400 hover:underline"
                    >
                      Load in Console
                    </button>
                  </div>
                </div>

                <div className="p-4 flex items-center justify-between hover:bg-neutral-800/40 transition-colors">
                  <div className="flex items-center gap-3">
                    <span className="px-2 py-0.5 text-xs font-mono font-semibold rounded bg-sky-500/10 text-sky-400 border border-sky-500/20">
                      GET
                    </span>
                    <span className="font-mono text-neutral-200">/api/profile</span>
                  </div>
                  <div className="flex items-center gap-4 text-xs text-neutral-400">
                    <span className="flex items-center gap-1 text-amber-400">
                      <Key className="w-3 h-3" /> Requires Bearer Token
                    </span>
                    <button 
                      onClick={() => { setTestEndpoint('/api/profile'); }}
                      className="text-emerald-400 hover:underline"
                    >
                      Load in Console
                    </button>
                  </div>
                </div>

                <div className="p-4 flex items-center justify-between hover:bg-neutral-800/40 transition-colors">
                  <div className="flex items-center gap-3">
                    <span className="px-2 py-0.5 text-xs font-mono font-semibold rounded bg-sky-500/10 text-sky-400 border border-sky-500/20">
                      GET
                    </span>
                    <span className="font-mono text-neutral-200">/api/documents</span>
                  </div>
                  <div className="flex items-center gap-4 text-xs text-neutral-400">
                    <span className="flex items-center gap-1 text-amber-400">
                      <Key className="w-3 h-3" /> Requires Bearer Token
                    </span>
                    <button 
                      onClick={() => { setTestEndpoint('/api/documents'); }}
                      className="text-emerald-400 hover:underline"
                    >
                      Load in Console
                    </button>
                  </div>
                </div>

                <div className="p-4 flex items-center justify-between hover:bg-neutral-800/40 transition-colors">
                  <div className="flex items-center gap-3">
                    <span className="px-2 py-0.5 text-xs font-mono font-semibold rounded bg-sky-500/10 text-sky-400 border border-sky-500/20">
                      GET
                    </span>
                    <span className="font-mono text-neutral-200">/api/documents/:documentId/download</span>
                  </div>
                  <div className="flex items-center gap-4 text-xs text-neutral-400">
                    <span className="flex items-center gap-1 text-amber-400">
                      <Key className="w-3 h-3" /> Requires Bearer Token
                    </span>
                    <button 
                      onClick={() => { setTestEndpoint('/api/documents/doc_123/download'); }}
                      className="text-emerald-400 hover:underline"
                    >
                      Load in Console
                    </button>
                  </div>
                </div>

                <div className="p-4 flex items-center justify-between hover:bg-neutral-800/40 transition-colors">
                  <div className="flex items-center gap-3">
                    <span className="px-2 py-0.5 text-xs font-mono font-semibold rounded bg-amber-500/10 text-amber-400 border border-amber-500/20">
                      POST
                    </span>
                    <span className="font-mono text-neutral-200">/api/documents/upload</span>
                  </div>
                  <div className="flex items-center gap-4 text-xs text-neutral-400">
                    <span className="flex items-center gap-1 text-amber-400">
                      <Key className="w-3 h-3" /> Requires Bearer Token
                    </span>
                    <button 
                      onClick={() => { setTestEndpoint('/api/documents/upload'); }}
                      className="text-emerald-400 hover:underline"
                    >
                      Load in Console
                    </button>
                  </div>
                </div>
              </div>
            </div>

            {/* Interactive Test Console */}
            <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-6">
              <h3 className="text-base font-semibold text-neutral-100 mb-1 flex items-center gap-2">
                <Terminal className="w-5 h-5 text-emerald-400" />
                Interactive API Test Console
              </h3>
              <p className="text-xs text-neutral-400 mb-5">
                Send live HTTP requests to the Express server to verify responses, auth middleware, and error handling.
              </p>

              <div className="space-y-4">
                <div>
                  <label className="block text-xs font-medium text-neutral-300 mb-1.5">
                    Target Endpoint
                  </label>
                  <select
                    value={testEndpoint}
                    onChange={(e) => setTestEndpoint(e.target.value)}
                    className="w-full bg-neutral-950 border border-neutral-800 rounded-lg px-3 py-2 text-sm text-neutral-200 font-mono focus:outline-none focus:border-emerald-500"
                  >
                    <option value="/api/health">GET /api/health (Public)</option>
                    <option value="/api/health/firebase">GET /api/health/firebase (Protected Test - Firestore Check)</option>
                    <option value="/api/drive/test">GET /api/drive/test (Protected - Google Drive Access Test)</option>
                    <option value="/api/profile">GET /api/profile (Protected)</option>
                    <option value="/api/documents">GET /api/documents (Protected)</option>
                    <option value="/api/documents/doc_sample_1/download">GET /api/documents/:documentId/download (Protected)</option>
                    <option value="/api/documents/upload">POST /api/documents/upload (Protected)</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-medium text-neutral-300 mb-1.5">
                    Authorization Header: <code className="text-neutral-400 font-mono text-xs">Bearer &lt;Firebase ID Token&gt;</code>
                  </label>
                  <input
                    type="text"
                    value={tokenInput}
                    onChange={(e) => setTokenInput(e.target.value)}
                    placeholder="Leave blank to test 401 Unauthorized rejection, or paste a Firebase ID token"
                    className="w-full bg-neutral-950 border border-neutral-800 rounded-lg px-3 py-2 text-xs text-neutral-200 font-mono focus:outline-none focus:border-emerald-500"
                  />
                  <p className="text-[11px] text-neutral-500 mt-1">
                    Testing protected routes without a token confirms the authentication middleware rejection works properly.
                  </p>
                </div>

                <div className="pt-2">
                  <button
                    onClick={handleRunTest}
                    disabled={loading}
                    id="execute-api-test-button"
                    className="px-4 py-2 rounded-lg bg-emerald-500 hover:bg-emerald-600 text-neutral-950 font-medium text-xs transition-colors flex items-center gap-2"
                  >
                    {loading ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Terminal className="w-3.5 h-3.5" />}
                    Send Test Request
                  </button>
                </div>

                {testResponse && (
                  <div className="mt-4 pt-4 border-t border-neutral-800">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-xs font-medium text-neutral-300">Server Response</span>
                      {testStatus && (
                        <span className={`text-xs font-mono px-2 py-0.5 rounded ${
                          testStatus >= 200 && testStatus < 300 
                            ? 'bg-emerald-500/20 text-emerald-400' 
                            : 'bg-amber-500/20 text-amber-400'
                        }`}>
                          HTTP {testStatus}
                        </span>
                      )}
                    </div>
                    <pre className="bg-neutral-950 border border-neutral-800 rounded-lg p-4 font-mono text-xs text-neutral-300 overflow-x-auto max-h-72">
                      {testResponse}
                    </pre>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Tab 3: Android Integration */}
        {activeTab === 'android' && (
          <div className="space-y-6">
            <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-6">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-base font-semibold text-neutral-100 flex items-center gap-2">
                  <Smartphone className="w-5 h-5 text-emerald-400" />
                  Android Client Connection Guide
                </h2>
                <button
                  onClick={() => copyToClipboard(androidCodeSnippet, 'android-snippet')}
                  className="text-xs text-neutral-300 hover:text-white px-2.5 py-1.5 rounded bg-neutral-800 border border-neutral-700 flex items-center gap-1.5 transition-colors"
                >
                  {copiedSnippet === 'android-snippet' ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                  {copiedSnippet === 'android-snippet' ? 'Copied' : 'Copy Code'}
                </button>
              </div>

              <p className="text-sm text-neutral-300 mb-4 leading-relaxed">
                Your existing Android app already signs in with Firebase Authentication. 
                To call this backend, retrieve the current user&apos;s Firebase ID token using <code className="font-mono text-emerald-400 text-xs">getIdToken(true)</code> and attach it as a Bearer token in the <code className="font-mono text-emerald-400 text-xs">Authorization</code> header:
              </p>

              <pre className="bg-neutral-950 border border-neutral-800 rounded-lg p-4 font-mono text-xs text-neutral-300 overflow-x-auto leading-relaxed">
                {androidCodeSnippet}
              </pre>
            </div>

            {/* Firestore User Schema */}
            <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-6">
              <h3 className="text-base font-semibold text-neutral-100 mb-2 flex items-center gap-2">
                <Database className="w-5 h-5 text-emerald-400" />
                Firestore User Profile Document Schema
              </h3>
              <p className="text-xs text-neutral-400 mb-4">
                The profile endpoint queries <code className="text-emerald-400 font-mono">users/{'{firebaseUid}'}</code>. Here is the expected document structure:
              </p>

              <pre className="bg-neutral-950 border border-neutral-800 rounded-lg p-4 font-mono text-xs text-emerald-400 overflow-x-auto">
{`// Collection: users/{firebaseUid}
{
  "name": "Jane Doe",
  "email": "jane.doe@example.com",
  "phone": "+91 9876543210",
  "panNumber": "ABCDE1234F",
  "driveFolderId": "1a2B3c4D5e6F7g8H9i",
  "role": "client",
  "status": "active",
  "createdAt": "2026-01-15T10:00:00Z",
  "updatedAt": "2026-09-10T12:00:00Z"
}`}
              </pre>

              <div className="mt-4 pt-4 border-t border-neutral-800">
                <h4 className="text-xs font-semibold text-neutral-200 mb-2">
                  Client Profile Response: <code className="text-emerald-400 font-mono">GET /api/profile</code>
                </h4>
                <p className="text-xs text-neutral-400 mb-2">
                  <code className="text-amber-400 font-mono">driveFolderId</code> is strictly excluded from client responses to maintain server-side authorization privacy. The authenticated client receives both masked and full PAN numbers.
                </p>
                <pre className="bg-neutral-950 border border-neutral-800 rounded-lg p-3 font-mono text-xs text-sky-400 overflow-x-auto">
{`{
  "name": "Jane Doe",
  "email": "jane.doe@example.com",
  "phone": "+91 9876543210",
  "maskedPanNumber": "XXXXXX234F",
  "panNumber": "ABCDE1234F",
  "role": "client",
  "status": "active"
}`}
                </pre>
              </div>
            </div>
          </div>
        )}

        {/* Tab 4: Config & Environment Variables */}
        {activeTab === 'config' && (
          <div className="space-y-6">
            <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-6">
              <h2 className="text-base font-semibold text-neutral-100 mb-2 flex items-center gap-2">
                <Key className="w-5 h-5 text-emerald-400" />
                How to Configure Firebase Credentials
              </h2>
              <p className="text-sm text-neutral-300 leading-relaxed mb-6">
                In strict compliance with project rules, <strong>no credentials or service accounts are hardcoded in the codebase</strong>.
                Configure your server using environment variables or Google Cloud Application Default Credentials.
              </p>

              <div className="space-y-4">
                <div className="p-4 rounded-lg bg-neutral-950 border border-neutral-800">
                  <h4 className="text-sm font-semibold text-neutral-200 mb-1">Option 1: Server Environment Variables</h4>
                  <p className="text-xs text-neutral-400 mb-3">
                    Add these variables into your Cloud Run service secrets or deployment environment:
                  </p>
                  <pre className="bg-neutral-900 p-3 rounded font-mono text-xs text-emerald-400 overflow-x-auto">
{`FIREBASE_PROJECT_ID="your-firebase-project-id"
FIREBASE_CLIENT_EMAIL="firebase-adminsdk-xyz@your-firebase-project-id.iam.gserviceaccount.com"
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\\nMIIEvg...\\n-----END PRIVATE KEY-----\\n"`}
                  </pre>
                </div>

                <div className="p-4 rounded-lg bg-neutral-950 border border-neutral-800">
                  <h4 className="text-sm font-semibold text-neutral-200 mb-1">Option 2: Single Service Account JSON String</h4>
                  <p className="text-xs text-neutral-400 mb-3">
                    Paste the entire JSON string into a single secret variable:
                  </p>
                  <pre className="bg-neutral-900 p-3 rounded font-mono text-xs text-emerald-400 overflow-x-auto">
{`FIREBASE_SERVICE_ACCOUNT_JSON='{"type":"service_account","project_id":"...","private_key":"...","client_email":"..."}'`}
                  </pre>
                </div>

                <div className="p-4 rounded-lg bg-neutral-950 border border-neutral-800">
                  <h4 className="text-sm font-semibold text-neutral-200 mb-1">Option 3: Google Cloud Application Default Credentials (ADC)</h4>
                  <p className="text-xs text-neutral-400">
                    If this service runs in Google Cloud Run within the same project as your Firebase account, simply assign the <strong>Firebase Authentication Viewer</strong> and <strong>Cloud Datastore User</strong> roles to the Cloud Run runtime service account. The Admin SDK automatically authenticates via ADC without requiring any private keys!
                  </p>
                </div>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
