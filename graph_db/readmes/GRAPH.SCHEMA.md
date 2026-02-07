# RedAmon Neo4j Graph Schema

## Overview

This document defines the Neo4j graph database schema for storing reconnaissance data.
The schema is designed to enable attack chain analysis by connecting all discovered assets,
services, technologies, and vulnerabilities in a navigable graph structure.

---

## 🎯 Design Principles

1. **Hierarchical Ownership**: All nodes trace back to a Domain with `user_id` and `project_id`
2. **Attack Surface Mapping**: Every potential entry point is modeled (ports, URLs, parameters)
3. **Technology-Vulnerability Linkage**: Technologies connect to known CVEs for risk assessment
4. **No Redundancy**: Information stored once, relationships handle connections
5. **Query Efficiency**: Optimized for path traversal (attack chains)
6. **Multi-Tenant Isolation**: Every node has `user_id` + `project_id` for tenant filtering

---

## 🏗️ Multi-Tenant AWS Scalability Strategy

This schema uses **Logical Partitioning with Composite Indexes** for multi-tenant isolation.
Every node type includes `user_id` and `project_id` properties with composite indexes.

### Why This Approach?

```
┌─────────────────────────────────────────────────────────────────┐
│                    Single Neo4j Database                        │
│                                                                 │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐             │
│  │  User A     │  │  User B     │  │  User C     │  ...        │
│  │  Project 1  │  │  Project 1  │  │  Project 1  │             │
│  │  Project 2  │  │  Project 2  │  │  Project 2  │             │
│  └─────────────┘  └─────────────┘  └─────────────┘             │
│                                                                 │
│  Composite Index: (user_id, project_id) on ALL node types       │
│  Query Pattern: Always filter by tenant FIRST                   │
└─────────────────────────────────────────────────────────────────┘
```

### Query Pattern (CRITICAL)

All queries **MUST** start by filtering on `user_id` and `project_id` to leverage indexes:

```cypher
// ✅ CORRECT - Uses composite index, scans only tenant's data
MATCH (d:Domain {user_id: $userId, project_id: $projectId})
-[:HAS_SUBDOMAIN]->(s:Subdomain)
-[:RESOLVES_TO]->(ip:IP)
-[:HAS_PORT]->(p:Port)
RETURN d, s, ip, p

// ❌ WRONG - Full graph scan, affects all tenants
MATCH (v:Vulnerability {severity: 'critical'})
RETURN v
```

### AWS Deployment Architecture

```
Node.js API (EKS/ECS Fargate)
        │
        ├── ElastiCache Redis ─── Query caching per tenant
        │
        └── Neo4j AuraDB / Neo4j on EC2
                │
                └── Composite indexes on (user_id, project_id)
```

### Scaling Path

| Phase | Users | Strategy | AWS Services |
|-------|-------|----------|--------------|
| MVP | 0-100 | Single DB + Indexes | ECS Fargate, Neo4j AuraDB |
| Growth | 100-1K | Read Replicas | EKS, AuraDB Professional |
| Scale | 1K+ | Sharded by User Pools | EKS Multi-AZ, Neo4j Cluster |

---

## 📊 Node Types

> ⚠️ **IMPORTANT**: All node types below implicitly include `user_id` and `project_id` properties
> for multi-tenant isolation, even if not shown in the examples. These are indexed with composite
> indexes for optimal query performance. See [Tenant Composite Indexes](#tenant-composite-indexes-critical-for-multi-tenant-query-performance).

### 1. Domain (Root Node)
The entry point for all queries. Contains project/user ownership.

```cypher
(:Domain {
    name: "vulnweb.com",                    // Root domain name (UNIQUE)
    user_id: "samgiam",                     // Owner/user identifier
    project_id: "first_test",               // Project identifier
    scan_timestamp: datetime,               // When scan was performed
    scan_type: "domain_discovery_port_scan_http_probe_vuln_scan",
    target: "testphp.vulnweb.com",          // Original target (may differ from root)
    filtered_mode: true,                    // Was SUBDOMAIN_LIST filter used?
    subdomain_filter: ["testphp."],         // Subdomain prefixes from SUBDOMAIN_LIST
    modules_executed: ["whois", "dns_resolution", "port_scan", "http_probe", "vuln_scan"],
    
    // Scan modes (from metadata)
    anonymous_mode: false,                   // Was Tor used?
    bruteforce_mode: false,                  // Was subdomain bruteforcing enabled?
    
    // WHOIS Information
    registrar: "Gandi SAS",
    registrar_url: "http://www.gandi.net",
    whois_server: "whois.gandi.net",
    creation_date: datetime,
    expiration_date: datetime,
    updated_date: datetime,
    dnssec: "unsigned",
    
    // Owner Information
    organization: "Invicti Security Limited",
    country: "MT",
    city: "REDACTED FOR PRIVACY",           // City (often redacted)
    state: null,                             // State/province
    address: "REDACTED FOR PRIVACY",         // Street address
    registrant_postal_code: "REDACTED FOR PRIVACY",
    
    // Contact Information (may be redacted)
    registrant_name: "REDACTED FOR PRIVACY",
    admin_name: "REDACTED FOR PRIVACY",
    admin_org: "REDACTED FOR PRIVACY",
    tech_name: "REDACTED FOR PRIVACY",
    tech_org: "REDACTED FOR PRIVACY",
    
    // Status
    status: ["clientTransferProhibited"],
    
    // WHOIS Contact Emails
    whois_emails: ["abuse@support.gandi.net", "...@contact.gandi.net"],
    
    // WHOIS extra fields
    domain_name: "VULNWEB.COM",              // Registered domain name (uppercase)
    referral_url: null,                      // Referral URL if any
    reseller: null,                          // Reseller if any
    
    // Name servers (moved from separate node)
    name_servers: ["NS-105-A.GANDI.NET", "NS-105-B.GANDI.NET", "NS-105-C.GANDI.NET"]
})
```

**Constraints:**
```cypher
CREATE CONSTRAINT domain_unique IF NOT EXISTS
FOR (d:Domain) REQUIRE (d.name, d.user_id, d.project_id) IS UNIQUE;

CREATE INDEX domain_user_project IF NOT EXISTS
FOR (d:Domain) ON (d.user_id, d.project_id);
```

---

### 2. Subdomain
Discovered subdomains/hostnames under a domain.

```cypher
(:Subdomain {
    name: "testphp.vulnweb.com",           // Full hostname (UNIQUE per domain)
    has_dns_records: true,
    discovered_at: datetime
})
```

**Constraints:**
```cypher
CREATE CONSTRAINT subdomain_unique IF NOT EXISTS
FOR (s:Subdomain) REQUIRE s.name IS UNIQUE;

CREATE INDEX subdomain_name IF NOT EXISTS
FOR (s:Subdomain) ON (s.name);
```

---

### 3. IP
IP addresses discovered through DNS resolution.

```cypher
(:IP {
    address: "44.228.249.3",               // IP address (UNIQUE)
    version: "ipv4",                        // ipv4 or ipv6
    is_cdn: true,
    cdn_name: "aws",
    asn: "AS16509",                         // Autonomous System Number
    asn_org: "Amazon.com, Inc."
})
```

**Constraints:**
```cypher
CREATE CONSTRAINT ip_unique IF NOT EXISTS
FOR (i:IP) REQUIRE i.address IS UNIQUE;

CREATE INDEX ip_address IF NOT EXISTS
FOR (i:IP) ON (i.address);
```

---

### 4. Port
Open ports discovered on IPs/hosts.

```cypher
(:Port {
    number: 80,                             // Port number
    protocol: "tcp",                        // tcp or udp
    state: "open"
})
```

**Note:** Port nodes are connected to both IP and Subdomain to show which host has which port open.

---

### 5. Service
Services running on ports.

```cypher
(:Service {
    name: "http",                           // Service name
    product: "nginx",                       // Product name (if detected)
    version: "1.19.0",                      // Version (if detected)
    banner: "nginx/1.19.0",                 // Raw banner
    extra_info: "Ubuntu"
})
```

---

### 6. BaseURL
Root/base web endpoints discovered through HTTP probing. These represent the entry points discovered by httpx.
Specific paths and endpoints discovered during vulnerability scanning are stored in separate Endpoint nodes.

```cypher
(:BaseURL {
    url: "http://testphp.vulnweb.com",     // Full base URL (UNIQUE)
    scheme: "http",                         // http or https
    host: "testphp.vulnweb.com",            // Hostname
    status_code: 200,
    content_type: "text/html",
    content_length: 2295,
    title: "Acunetix Test Site",
    server: "nginx/1.19.0",
    is_live: true,
    response_time_ms: null,                 // Response time in milliseconds

    // Discovery source
    source: "http_probe",                   // http_probe

    // Network info
    resolved_ip: "44.228.249.3",
    cname: null,                            // CNAME if any
    cdn: "aws",
    is_cdn: true,
    asn: null,

    // Fingerprints
    favicon_hash: "-1187092235",
    body_sha256: "a42521a54c7bcc2dbc2f7010dd22c17c566f3bda167e662c6086c94bf9ebfb62",
    header_sha256: "fbbea705962aa40edced75d2fb430f4a8295b7ab79345a272d1376dd150460cd",

    // Response metadata
    word_count: 11,
    line_count: 6
})
```

**Constraints:**
```cypher
CREATE CONSTRAINT baseurl_unique IF NOT EXISTS
FOR (u:BaseURL) REQUIRE u.url IS UNIQUE;

CREATE INDEX baseurl_status IF NOT EXISTS
FOR (u:BaseURL) ON (u.status_code);
```

---

### 7. Certificate
TLS/SSL certificates discovered during HTTP probing. Contains certificate metadata for security analysis.

```cypher
(:Certificate {
    subject_cn: "*.beta80group.it",          // Common Name (UNIQUE per project)
    user_id: "samgiam",                       // Owner/user identifier
    project_id: "project_2",                  // Project identifier
    issuer: "DigiCert Inc",                   // Certificate issuer
    not_before: "2025-09-02T00:00:00Z",       // Valid from date
    not_after: "2026-10-03T23:59:59Z",        // Expiration date
    san: ["*.beta80group.it", "beta80group.it"],  // Subject Alternative Names
    cipher: "TLS_AES_128_GCM_SHA256",         // TLS cipher suite
    tls_version: "TLSv1.3",                   // TLS version (if detected)
    source: "http_probe"                      // Discovery source
})
```

**Constraints:**
```cypher
CREATE CONSTRAINT cert_unique IF NOT EXISTS
FOR (c:Certificate) REQUIRE (c.subject_cn, c.project_id) IS UNIQUE;
```

---

### 8. Endpoint
Specific web application endpoints (paths) discovered through Katana crawling or vulnerability scanning.
These are linked to their parent BaseURL and contain discovered parameters.

```cypher
(:Endpoint {
    // Core properties
    path: "/artists.php",                   // Path without query string
    method: "GET",                          // HTTP method (GET, POST, PUT, DELETE, etc.)
    baseurl: "http://testphp.vulnweb.com",  // Parent base URL
    has_parameters: true,                   // Does this endpoint have parameters?
    full_url: "http://testphp.vulnweb.com/artists.php",  // Full URL without query params
    source: "katana_crawl",                 // katana_crawl, vuln_scan, resource_enum
    category: "dynamic",                    // dynamic, static, authentication, search, api, other
    query_param_count: 1,                   // Number of query parameters
    body_param_count: 0,                    // Number of body parameters
    path_param_count: 0,                    // Number of path parameters
    urls_found: 3,                          // Number of URLs pointing to this endpoint

    // Form properties (for POST endpoints discovered via HTML forms)
    is_form: true,                          // True if this endpoint receives form submissions
    form_enctype: "application/x-www-form-urlencoded",  // Form encoding type
    form_found_at_pages: [                  // Pages where this form was discovered
        "http://testphp.vulnweb.com/login.php",
        "http://testphp.vulnweb.com/index.php"
    ],
    form_input_names: ["username", "password"],  // Input field names from the form
    form_count: 2                           // Number of pages containing this form
})
```

---

### 8. Parameter
URL parameters that represent potential attack vectors. These are discovered through Katana crawling
and marked as injectable when vulnerabilities are found through DAST scanning.

```cypher
(:Parameter {
    name: "artist",                         // Parameter name
    position: "query",                      // query, body, header, path
    endpoint_path: "/artists.php",          // Parent endpoint path
    baseurl: "http://testphp.vulnweb.com",  // Parent base URL
    sample_value: "1",                      // Example value seen
    is_injectable: true                     // Marked true if vuln found affecting this param
})
```

**Indexes:**
```cypher
CREATE INDEX param_injectable IF NOT EXISTS
FOR (p:Parameter) ON (p.is_injectable);
```

---

### 9. Technology
Detected technologies, frameworks, and software.

```cypher
(:Technology {
    name: "PHP",                            // Technology name
    version: "5.6.40",                      // Primary version (if detected)
    versions_all: ["5.6.40"],               // All versions detected (from wappalyzer)
    name_version: "PHP:5.6.40",             // Combined identifier
    categories: ["Programming languages"],  // Technology categories
    confidence: 100,                        // Detection confidence (0-100)
    
    // Source tracking
    detected_by: "httpx",                   // httpx, wappalyzer, banner_grab
    
    // For CVE lookup matching
    product: "php",                         // Normalized product name for CVE lookup
    cpe_vendor: "php",                      // CPE vendor (if known)
    
    // CVE Summary (denormalized for quick access)
    known_cve_count: 17,
    critical_cve_count: 2,
    high_cve_count: 5,
    medium_cve_count: 10,
    low_cve_count: 0
})
```

**Constraints:**
```cypher
CREATE INDEX tech_name IF NOT EXISTS
FOR (t:Technology) ON (t.name);

CREATE INDEX tech_name_version IF NOT EXISTS
FOR (t:Technology) ON (t.name, t.version);

CREATE INDEX tech_product IF NOT EXISTS
FOR (t:Technology) ON (t.product);
```

---

### 10. Vulnerability
Discovered vulnerabilities from active scanning.

```cypher
(:Vulnerability {
    id: "sqli-error-based-artists-artist",  // Unique identifier (generated)
    template_id: "sqli-error-based",        // Scanner template ID
    template_path: "dast/vulnerabilities/sqli/sqli-error-based.yaml",
    template_url: "https://cloud.projectdiscovery.io/public/sqli-error-based",
    name: "Error based SQL Injection",
    description: "Direct SQL Command Injection...",
    severity: "critical",                    // critical, high, medium, low, info
    category: "sqli",                        // Vulnerability category
    tags: ["sqli", "error", "dast", "vuln"],
    authors: ["geeknik", "pdteam"],          // Template authors
    references: [],                          // Reference URLs
    
    // Classification
    cwe_ids: ["CWE-89"],                     // CWE identifiers
    cvss_score: null,                        // CVSS if available
    cvss_metrics: "",                        // CVSS vector string
    
    // Attack details
    matched_at: "http://testphp.vulnweb.com/artists.php?artist=3'",
    matcher_name: "",                        // Specific matcher that triggered
    matcher_status: true,                    // Whether matcher succeeded
    extractor_name: "mysql",                 // What was extracted (e.g., db type)
    extracted_results: ["SQL syntax; check the manual..."],
    
    // Request/Response details
    request_type: "http",                    // http, dns, tcp, etc.
    scheme: "http",
    host: "testphp.vulnweb.com",
    port: "80",
    path: "/artists.php",
    matched_ip: "44.228.249.3",              // IP where vuln was found
    
    // DAST specific
    is_dast_finding: true,
    fuzzing_method: "GET",
    fuzzing_parameter: "artist",
    fuzzing_position: "query",               // query, body, header, path
    
    // Template metadata
    max_requests: 3,                         // from raw.info.metadata.max-request
    
    // Reproduction
    curl_command: "curl -X 'GET' ...",
    
    // Raw request/response (for evidence & reproduction)
    raw_request: "GET /artists.php?artist=3' HTTP/1.1\nHost: ...",
    raw_response: "HTTP/1.1 200 OK\nConnection: close\n...",
    
    // Metadata
    discovered_at: datetime
})
```

**Constraints:**
```cypher
CREATE INDEX vuln_severity IF NOT EXISTS
FOR (v:Vulnerability) ON (v.severity);

CREATE INDEX vuln_category IF NOT EXISTS
FOR (v:Vulnerability) ON (v.category);
```

---

### 11. CVE
Known CVEs from technology-based lookup.

```cypher
(:CVE {
    id: "CVE-2021-3618",                   // CVE ID (UNIQUE)
    cvss: 7.4,                              // CVSS score
    severity: "HIGH",                       // CRITICAL, HIGH, MEDIUM, LOW
    description: "ALPACA is an application layer...",
    published: datetime,
    source: "nvd",                          // Data source
    url: "https://nvd.nist.gov/vuln/detail/CVE-2021-3618",
    references: ["https://alpaca-attack.com/"]
})
```

**Constraints:**
```cypher
CREATE CONSTRAINT cve_unique IF NOT EXISTS
FOR (c:CVE) REQUIRE c.id IS UNIQUE;

CREATE INDEX cve_severity IF NOT EXISTS
FOR (c:CVE) ON (c.severity);

CREATE INDEX cve_cvss IF NOT EXISTS
FOR (c:CVE) ON (c.cvss);
```

---

### 12. MitreData
CWE (Common Weakness Enumeration) data from MITRE enrichment. Each CVE can have a hierarchical chain
of CWE nodes representing the weakness hierarchy from root to leaf CWE.

```cypher
(:MitreData {
    id: "CVE-2021-3618-CWE-295",           // Unique ID (CVE + CWE combination)
    cve_id: "CVE-2021-3618",               // Parent CVE ID
    cwe_id: "CWE-295",                      // CWE identifier
    cwe_name: "Improper Certificate Validation",
    cwe_description: "The software does not validate, or incorrectly validates...",
    cwe_url: "https://cwe.mitre.org/data/definitions/295.html",
    abstraction: "Base",                    // Pillar, Class, Base, Variant
    is_leaf: true,                          // Is this the most specific CWE?
    platforms: ["Not Language-Specific"]    // Applicable platforms
})
```

**Constraints:**
```cypher
CREATE CONSTRAINT mitredata_unique IF NOT EXISTS
FOR (m:MitreData) REQUIRE m.id IS UNIQUE;

CREATE INDEX idx_mitredata_tenant IF NOT EXISTS
FOR (m:MitreData) ON (m.user_id, m.project_id);
```

---

### 13. Capec
CAPEC (Common Attack Pattern Enumeration and Classification) nodes linked to CWE weaknesses.
Only created when a CWE has non-empty `related_capec` data.

```cypher
(:Capec {
    capec_id: "CAPEC-94",                  // CAPEC identifier (UNIQUE)
    numeric_id: 94,                         // Numeric ID
    name: "Man in the Middle Attack",
    description: "This type of attack targets the communication between two parties...",
    url: "https://capec.mitre.org/data/definitions/94.html",
    likelihood: "Medium",                   // High, Medium, Low
    severity: "Very High",                  // Very High, High, Medium, Low, Very Low
    prerequisites: "There are two components communicating with each other...",
    execution_flow: "[JSON stringified attack phases]",  // Attack execution steps
    related_cwes: ["CWE-295", "CWE-300"]   // Related CWE IDs
})
```

**Constraints:**
```cypher
CREATE CONSTRAINT capec_unique IF NOT EXISTS
FOR (cap:Capec) REQUIRE cap.capec_id IS UNIQUE;

CREATE INDEX capec_id IF NOT EXISTS
FOR (c:Capec) ON (c.capec_id);

CREATE INDEX idx_capec_tenant IF NOT EXISTS
FOR (c:Capec) ON (c.user_id, c.project_id);
```

---

### 14. DNSRecord
DNS records for subdomains.

```cypher
(:DNSRecord {
    type: "A",                              // A, AAAA, MX, NS, TXT, CNAME, SOA
    value: "44.228.249.3",                  // Record value
    ttl: 300                                // Time to live (if available)
})
```

---

### 15. Header
HTTP response headers (all captured headers).

```cypher
(:Header {
    name: "X-Powered-By",                   // Header name
    value: "PHP/5.6.40-38+ubuntu20.04.1+deb.sury.org+1",
    is_security_header: false,              // Is this a security header?
    reveals_technology: true                // Does this reveal server tech?
})
```

**Common headers to capture:**
- `Server` - Web server identification
- `X-Powered-By` - Backend technology
- `X-AspNet-Version` - .NET version
- `Content-Type` - Content type info
- `Content-Encoding` - Compression info
- Security headers: `X-Frame-Options`, `X-XSS-Protection`, `Content-Security-Policy`, `Strict-Transport-Security`

---

### 19. Exploit

**Label:** `Exploit`
**Created by:** AI agent orchestrator (automatic, when exploitation succeeds)
**Detection:** LLM-based analysis of tool output (`exploit_succeeded` field in `OutputAnalysis`)

| Property | Type | Description |
|----------|------|-------------|
| `id` | String | Deterministic ID for MERGE idempotency |
| `user_id` | String | Tenant user ID |
| `project_id` | String | Tenant project ID |
| `attack_type` | String | `"cve_exploit"` or `"brute_force"` |
| `severity` | String | Always `"critical"` |
| `target_ip` | String | IP address of exploited target |
| `target_port` | Integer | Port number targeted (optional) |
| `cve_ids` | String[] | CVE IDs exploited (for cve_exploit) |
| `metasploit_module` | String | Metasploit module used (optional) |
| `payload` | String | Payload used (optional) |
| `session_id` | Integer | Metasploit session ID (optional) |
| `username` | String | Compromised username (for brute_force) |
| `password` | String | Compromised password (for brute_force) |
| `report` | String | Structured exploitation report |
| `evidence` | String | LLM-provided evidence of success |
| `commands_used` | String[] | Metasploit commands used |
| `created_at` | DateTime | Node creation timestamp |

**Relationships:**
```cypher
// CVE exploitation path
(Exploit)-[:EXPLOITED_CVE]->(CVE)
(Exploit)-[:TARGETED_IP]->(IP)

// Brute force path
(Exploit)-[:TARGETED_IP]->(IP)
(Exploit)-[:VIA_PORT]->(Port)
```

**Visual:** Diamond shape (2D) / Octahedron (3D), amber color (#f59e0b), always-on glow, lightning bolt icon.

---

---

## 🔗 Relationships

### Domain Relationships

```cypher
// Domain owns subdomains
(Domain)-[:HAS_SUBDOMAIN]->(Subdomain)

// Domain WHOIS contacts (if needed as separate nodes)
(Domain)-[:REGISTERED_BY {registrar_url: "..."}]->(Registrar)
```

---

### Subdomain Relationships

```cypher
// Subdomain resolves to IP addresses
(Subdomain)-[:RESOLVES_TO {record_type: "A"}]->(IP)

// Subdomain has DNS records
(Subdomain)-[:HAS_DNS_RECORD]->(DNSRecord)
```

---

### IP Relationships

```cypher
// IP has open ports
(IP)-[:HAS_PORT]->(Port)

// Port runs a service
(Port)-[:RUNS_SERVICE]->(Service)

// Service serves URLs (web endpoints)
(Service)-[:SERVES_URL]->(URL)
```

---

### BaseURL Relationships

```cypher
// BaseURL has endpoints (discovered paths from vuln_scan)
(BaseURL)-[:HAS_ENDPOINT]->(Endpoint)

// Endpoint has parameters
(Endpoint)-[:HAS_PARAMETER]->(Parameter)

// BaseURL uses technologies (detected by httpx/wappalyzer)
(BaseURL)-[:USES_TECHNOLOGY {confidence: 100, detected_by: "httpx"}]->(Technology)

// BaseURL has TLS certificate (if HTTPS)
(BaseURL)-[:HAS_CERTIFICATE]->(Certificate)

// BaseURL has HTTP headers
(BaseURL)-[:HAS_HEADER]->(Header)

// Security check vulnerabilities (missing headers, etc.) connect to BaseURL
(BaseURL)-[:HAS_VULNERABILITY]->(Vulnerability)

// Note: DAST vulnerabilities connect via Endpoint (FOUND_AT) and Parameter (AFFECTS_PARAMETER)
// rather than directly to BaseURL, to avoid redundant connections in the graph.
// Path: BaseURL -> Endpoint <- Vulnerability -> Parameter
```

---

### Vulnerability Relationships

**IMPORTANT: No Redundant Connections & No Isolated Nodes**

Each vulnerability connects to exactly ONE **existing** parent node based on its context.
This ensures vulnerabilities are always connected to the graph (no isolated nodes).

| Finding Type | Connects To | Why |
|--------------|-------------|-----|
| IP-based URL (`http://15.161.171.153`) | **IP only** | URL host is an IP - connect to existing IP node |
| Hostname URL (`https://example.com`) | **BaseURL** (existing) | Connect to existing BaseURL from http_probe |
| Hostname URL (no BaseURL exists) | **Subdomain/Domain** | Fallback to host node if BaseURL not found |
| Host-only (SSL issues on `example.com:443`) | **Subdomain only** | It's about the host, not a specific URL |
| DAST findings (SQLi, XSS) | **Endpoint** (via FOUND_AT) | It's about the specific path/parameter |

**Key Rules:**
1. **Never create isolated BaseURL nodes** - only connect to existing nodes
2. **IP-based URLs connect to IP nodes** - keeps direct IP access findings connected
3. **Hostname URLs try BaseURL first** - falls back to Subdomain/Domain if not found

This avoids:
```
❌ Subdomain -[:HAS_VULNERABILITY]-> Vulnerability
❌ BaseURL -[:HAS_VULNERABILITY]-> Vulnerability  (same vuln, redundant!)

❌ Creating isolated BaseURL nodes for IP-based URLs like http://15.161.171.153
   (These would have no connection to IP nodes in the graph)
```

Instead, use graph traversal to find related entities:
```cypher
// Find all vulnerabilities for a subdomain (via BaseURL)
MATCH (s:Subdomain)-[:RESOLVES_TO]->(:IP)-[:HAS_PORT]->(:Port)
      -[:RUNS_SERVICE]->(:Service)-[:SERVES_URL]->(bu:BaseURL)
      -[:HAS_VULNERABILITY]->(v:Vulnerability)
WHERE s.name = $hostname
RETURN v

// Find direct IP access vulnerabilities
MATCH (s:Subdomain)-[:RESOLVES_TO]->(ip:IP)-[:HAS_VULNERABILITY]->(v:Vulnerability)
WHERE v.type IN ['direct_ip_http', 'direct_ip_https']
RETURN s.name, ip.address, v.name, v.severity
```

```cypher
// Vulnerability affects parameter (the injectable parameter that was fuzzed)
(Vulnerability)-[:AFFECTS_PARAMETER]->(Parameter)

// Vulnerability found at endpoint (the path where the vulnerability was discovered)
(Vulnerability)-[:FOUND_AT]->(Endpoint)

// Vulnerability associated with CVE (if matched)
(Vulnerability)-[:ASSOCIATED_CVE]->(CVE)

// Security check vulnerabilities connect to the most specific EXISTING entity:
// Priority: IP (for IP-based URLs) > BaseURL > Subdomain/Domain

// - IP for IP-based URL findings (e.g., http://15.161.171.153 direct access)
//   Connects to existing IP node to stay integrated with graph
(IP)-[:HAS_VULNERABILITY]->(Vulnerability)

// - BaseURL for hostname URL findings (e.g., https://example.com missing headers)
//   Only connects to EXISTING BaseURL nodes (from http_probe)
(BaseURL)-[:HAS_VULNERABILITY]->(Vulnerability)

// - Subdomain/Domain for host-level findings (fallback when BaseURL doesn't exist)
(Subdomain)-[:HAS_VULNERABILITY]->(Vulnerability)
(Domain)-[:HAS_VULNERABILITY]->(Vulnerability)
```

---

### Technology Relationships

```cypher
// Technology has known CVEs
(Technology)-[:HAS_KNOWN_CVE]->(CVE)

// Technology runs on service
(Service)-[:POWERED_BY]->(Technology)
```

---

### CVE/MITRE Relationships

```cypher
// CVE has MITRE CWE data (root of CWE hierarchy)
(CVE)-[:HAS_MITRE_DATA]->(MitreData)

// MitreData (CWE) has child CWE in hierarchy
// Example: CWE-707 (Improper Neutralization) -> CWE-89 (SQL Injection)
(MitreData)-[:HAS_CHILD_CWE]->(MitreData)

// MitreData (CWE) links to related CAPEC attack patterns
// Only created when CWE has non-empty related_capec
(MitreData)-[:RELATED_CAPEC]->(Capec)
```

---

## 📐 Complete Graph Visualization

```
┌──────────┐                        ┌─────────────┐
│ Registrar│◄──REGISTERED_BY────────│   Domain    │
└──────────┘                        │ (user_id,   │
                                    │ project_id) │
                                    └──────┬──────┘
                                           │
                                    HAS_SUBDOMAIN
                                           │
                    ┌──────────────────────▼──────────────────────┐
                    │                 Subdomain                    │
                    └──────┬─────────────────────────┬────────────┘
                           │                         │
                    HAS_DNS_RECORD              RESOLVES_TO
                           │                         │
                    ┌──────▼──────┐            ┌─────▼─────┐
                    │ DNSRecord   │            │    IP     │
                    └─────────────┘            └─────┬─────┘
                                                     │
                                                HAS_PORT
                                                     │
                                               ┌─────▼─────┐
                                               │   Port    │
                                               └─────┬─────┘
                                                     │
                                               RUNS_SERVICE
                                                     │
                                               ┌─────▼─────┐
                                               │  Service  │
                                               └──┬─────┬──┘
                                                  │     │
                                            SERVES_URL  POWERED_BY
                                                  │     │
                                            ┌─────▼───┐ │
                                            │ BaseURL │─┼─────────────┐
                                            └─┬───┬───┘ │             │
                                              │   │     │         HAS_HEADER
                                     HAS_ENDPOINT │     │             │
                                              │   │ USES_TECHNOLOGY   │
                                              │   │     │         ┌───▼───┐
                                              │   │     │         │Header │
                                              │   │     │         └───────┘
                                              │   │     │
                                        ┌─────▼──┐│     │
                                        │Endpoint││     │
                                        └──┬──┬──┘│ ┌───▼──────────┐
                                           │  │   │ │  Technology  │
                                    HAS_PARAMETER │ └───────┬──────┘
                                           │  │   │         │
                                           │  │FOUND_AT     │
                                           │  │   │   HAS_KNOWN_CVE
                                     ┌─────▼──┼─┐ │         │
                                     │Parameter│ │  ┌──────▼──────┐
                                     └─────┬──┼─┘ │  │     CVE     │
                                           │  │   │  └──────▲──────┘
                                 AFFECTS_PARAMETER│         │
                                           │  │   │   ASSOCIATED_CVE
                                    ┌──────▼──▼───┤         │
                                    │ Vulnerability│◄───────┘
                                    │  (DAST)      │
                                    └──────────────┘


Security Check Vulnerabilities connect to EXISTING nodes only:

    IP-based URL findings (http://15.161.171.153):
    ┌────────┐  HAS_VULNERABILITY   ┌───────────────┐
    │   IP   │─────────────────────▶│ Vulnerability │
    │(exists)│                      │ (direct_ip_*) │
    └────────┘                      └───────────────┘

    Hostname URL findings (https://example.com):
    ┌─────────┐  HAS_VULNERABILITY   ┌───────────────┐
    │ BaseURL │─────────────────────▶│ Vulnerability │
    │ (exists)│                      │ (missing_hdr) │
    └─────────┘                      └───────────────┘

Note: Each vulnerability connects to exactly ONE EXISTING parent:
  - IP-based URL → IP node (keeps direct IP findings connected to graph)
  - Hostname URL → existing BaseURL (from http_probe)
  - Hostname URL (no BaseURL) → Subdomain/Domain (fallback)
  - No isolated nodes are created!
```

---

## 🔍 Key Query Patterns

### 1. Get All Assets for a Project
```cypher
MATCH (d:Domain {user_id: $user_id, project_id: $project_id})
MATCH path = (d)-[*1..5]->(n)
RETURN d, path
```

### 2. Find Attack Surface (All Parameters)
```cypher
MATCH (d:Domain {user_id: $user_id, project_id: $project_id})
      -[:HAS_SUBDOMAIN]->(s:Subdomain)
      -[:RESOLVES_TO]->(ip:IP)
      -[:HAS_PORT]->(p:Port)
      -[:RUNS_SERVICE]->(svc:Service)
      -[:SERVES_URL]->(u:BaseURL)
      -[:HAS_ENDPOINT]->(e:Endpoint)
      -[:HAS_PARAMETER]->(param:Parameter)
RETURN s.name AS host, svc.name AS service, p.number AS port, e.path AS endpoint, param.name AS parameter
```

### 3. Find All Critical Vulnerabilities
```cypher
MATCH (d:Domain {user_id: $user_id, project_id: $project_id})
      -[:HAS_SUBDOMAIN]->(s)
      -[:RESOLVES_TO]->(:IP)
      -[:HAS_PORT]->(:Port)
      -[:RUNS_SERVICE]->(svc:Service)
      -[:SERVES_URL]->(u:BaseURL)
      -[:HAS_ENDPOINT]->(e:Endpoint)<-[:FOUND_AT]-(v:Vulnerability {severity: "critical"})
RETURN s.name AS host, svc.name AS service, u.url AS url, v.name AS vulnerability, v.matched_at AS proof
```

### 4. Technology to CVE Mapping (Risk Assessment)
```cypher
MATCH (d:Domain {user_id: $user_id, project_id: $project_id})
      -[:HAS_SUBDOMAIN]->(s)
      -[:RESOLVES_TO]->(:IP)
      -[:HAS_PORT]->(port:Port)
      -[:RUNS_SERVICE]->(svc:Service)
      -[:SERVES_URL]->(u:BaseURL)
      -[:USES_TECHNOLOGY]->(t:Technology)
      -[:HAS_KNOWN_CVE]->(c:CVE)
WHERE c.cvss >= 7.0
RETURN t.name AS technology, t.version AS version, svc.name AS service, port.number AS port,
       collect({cve: c.id, cvss: c.cvss, severity: c.severity}) AS cves
ORDER BY max(c.cvss) DESC
```

### 5. Find Potential Attack Paths (SQLi to Database)
```cypher
MATCH (d:Domain {user_id: $user_id, project_id: $project_id})
      -[:HAS_SUBDOMAIN]->(s)
      -[:RESOLVES_TO]->(:IP)
      -[:HAS_PORT]->(port:Port)
      -[:RUNS_SERVICE]->(svc:Service)
      -[:SERVES_URL]->(u:BaseURL)
      -[:HAS_ENDPOINT]->(e:Endpoint)<-[:FOUND_AT]-(v:Vulnerability)
WHERE v.category = "sqli"
MATCH (u)-[:USES_TECHNOLOGY]->(t:Technology)
WHERE t.name IN ["MySQL", "PostgreSQL", "MSSQL", "Oracle"]
RETURN s.name AS host, svc.name AS service, port.number AS port, v.matched_at AS injection_point,
       v.extracted_results AS evidence, t.name AS database
```

### 6. Get Complete Host Profile
```cypher
MATCH (d:Domain {user_id: $user_id, project_id: $project_id})
      -[:HAS_SUBDOMAIN]->(s:Subdomain {name: $hostname})
OPTIONAL MATCH (s)-[:RESOLVES_TO]->(ip:IP)
OPTIONAL MATCH (ip)-[:HAS_PORT]->(port:Port)-[:RUNS_SERVICE]->(svc:Service)
OPTIONAL MATCH (svc)-[:SERVES_URL]->(u:BaseURL)-[:USES_TECHNOLOGY]->(tech:Technology)
OPTIONAL MATCH (u)-[:HAS_ENDPOINT]->(e:Endpoint)<-[:FOUND_AT]-(vuln:Vulnerability)
RETURN s, collect(DISTINCT ip) AS ips,
       collect(DISTINCT {port: port.number, service: svc.name}) AS services,
       collect(DISTINCT tech.name) AS technologies,
       collect(DISTINCT {name: vuln.name, severity: vuln.severity}) AS vulnerabilities
```

### 7. Vulnerability Summary by Category
```cypher
MATCH (d:Domain {user_id: $user_id, project_id: $project_id})
      -[:HAS_SUBDOMAIN]->()
      -[:RESOLVES_TO]->(:IP)
      -[:HAS_PORT]->(:Port)
      -[:RUNS_SERVICE]->(:Service)
      -[:SERVES_URL]->(:BaseURL)
      -[:HAS_ENDPOINT]->(:Endpoint)<-[:FOUND_AT]-(v:Vulnerability)
RETURN v.category AS category,
       count(v) AS count,
       collect(DISTINCT v.severity) AS severities
ORDER BY count DESC
```

### 8. Most Common Vulnerability Types
```cypher
MATCH (d:Domain {user_id: $user_id, project_id: $project_id})
      -[:HAS_SUBDOMAIN]->()
      -[:RESOLVES_TO]->(:IP)
      -[:HAS_PORT]->(:Port)
      -[:RUNS_SERVICE]->(:Service)
      -[:SERVES_URL]->(:BaseURL)
      -[:HAS_ENDPOINT]->(:Endpoint)<-[:FOUND_AT]-(v:Vulnerability)
RETURN v.template_id, v.name, v.severity, count(v) AS findings_count
ORDER BY findings_count DESC
LIMIT 10
```

### 9. Find All Injectable Parameters (Attack Surface)
```cypher
MATCH (d:Domain {user_id: $user_id, project_id: $project_id})
      -[:HAS_SUBDOMAIN]->(s)
      -[:RESOLVES_TO]->(:IP)
      -[:HAS_PORT]->(port:Port)
      -[:RUNS_SERVICE]->(svc:Service)
      -[:SERVES_URL]->(u:BaseURL)
      -[:HAS_ENDPOINT]->(e)
      -[:HAS_PARAMETER]->(p:Parameter {is_injectable: true})
OPTIONAL MATCH (v:Vulnerability)-[:AFFECTS_PARAMETER]->(p)
RETURN s.name AS host, svc.name AS service, port.number AS port, e.path AS endpoint, p.name AS parameter,
       p.position AS position, collect(v.category) AS vuln_types
```

### 10. HTTP Headers Analysis (Security Headers Check)
```cypher
MATCH (d:Domain {user_id: $user_id, project_id: $project_id})
      -[:HAS_SUBDOMAIN]->(s)
      -[:RESOLVES_TO]->(:IP)
      -[:HAS_PORT]->(:Port)
      -[:RUNS_SERVICE]->(svc:Service)
      -[:SERVES_URL]->(u:BaseURL)
      -[:HAS_HEADER]->(h:Header)
WHERE h.is_security_header = true OR h.reveals_technology = true
RETURN s.name AS host, svc.name AS service, u.url AS url,
       collect({header: h.name, value: h.value, security: h.is_security_header}) AS headers
```

---

## 📋 Node Property Summary

| Node | Key Properties | Indexed |
|------|---------------|---------|
| Domain | name, user_id, project_id, target, modules_executed, whois_*, anonymous_mode, bruteforce_mode | ✅ Composite unique |
| Subdomain | name, has_dns_records | ✅ Unique |
| IP | address, version, is_cdn, cdn_name, asn | ✅ Unique |
| Port | number, protocol, state | |
| Service | name, product, version, banner | |
| BaseURL | url, scheme, host, status_code, is_live, body_sha256 | ✅ Unique |
| Endpoint | path, method, baseurl, has_parameters, source | |
| Parameter | name, position, endpoint_path, baseurl, is_injectable, sample_value | ✅ is_injectable |
| Technology | name, version, categories, confidence, product, known_cve_count | ✅ name, ✅ name+version, ✅ product |
| Vulnerability | id, template_id, severity, category, matched_at, fuzzing_*, raw_request, raw_response, matched_ip | ✅ Unique, ✅ severity, ✅ category, ✅ template_id |
| CVE | id, cvss, severity, description, published | ✅ Unique, ✅ severity, ✅ cvss |
| MitreData | id, cve_id, cwe_id, cwe_name, cwe_description, abstraction, is_leaf | ✅ Unique |
| Capec | capec_id, name, description, likelihood, severity, prerequisites | ✅ Unique |
| DNSRecord | type, value, ttl | |
| Header | name, value, baseurl, is_security_header | |

---

## 🚀 Initialization Cypher

Run this to set up constraints and indexes before importing data:

```cypher
// =============================================================================
// CONSTRAINTS (uniqueness)
// =============================================================================

CREATE CONSTRAINT domain_unique IF NOT EXISTS
FOR (d:Domain) REQUIRE (d.name, d.user_id, d.project_id) IS UNIQUE;

CREATE CONSTRAINT subdomain_unique IF NOT EXISTS
FOR (s:Subdomain) REQUIRE s.name IS UNIQUE;

CREATE CONSTRAINT ip_unique IF NOT EXISTS
FOR (i:IP) REQUIRE i.address IS UNIQUE;

CREATE CONSTRAINT baseurl_unique IF NOT EXISTS
FOR (u:BaseURL) REQUIRE u.url IS UNIQUE;

CREATE CONSTRAINT vulnerability_unique IF NOT EXISTS
FOR (v:Vulnerability) REQUIRE v.id IS UNIQUE;

CREATE CONSTRAINT cve_unique IF NOT EXISTS
FOR (c:CVE) REQUIRE c.id IS UNIQUE;

CREATE CONSTRAINT mitredata_unique IF NOT EXISTS
FOR (m:MitreData) REQUIRE m.id IS UNIQUE;

CREATE CONSTRAINT capec_unique IF NOT EXISTS
FOR (cap:Capec) REQUIRE cap.capec_id IS UNIQUE;

// =============================================================================
// INDEXES (query performance)
// =============================================================================

// =============================================================================
// TENANT COMPOSITE INDEXES (CRITICAL for multi-tenant query performance)
// All queries MUST filter by user_id + project_id FIRST to leverage these indexes
// =============================================================================

CREATE INDEX idx_domain_tenant IF NOT EXISTS
FOR (d:Domain) ON (d.user_id, d.project_id);

CREATE INDEX idx_subdomain_tenant IF NOT EXISTS
FOR (s:Subdomain) ON (s.user_id, s.project_id);

CREATE INDEX idx_ip_tenant IF NOT EXISTS
FOR (i:IP) ON (i.user_id, i.project_id);

CREATE INDEX idx_port_tenant IF NOT EXISTS
FOR (p:Port) ON (p.user_id, p.project_id);

CREATE INDEX idx_service_tenant IF NOT EXISTS
FOR (svc:Service) ON (svc.user_id, svc.project_id);

CREATE INDEX idx_baseurl_tenant IF NOT EXISTS
FOR (u:BaseURL) ON (u.user_id, u.project_id);

CREATE INDEX idx_endpoint_tenant IF NOT EXISTS
FOR (e:Endpoint) ON (e.user_id, e.project_id);

CREATE INDEX idx_parameter_tenant IF NOT EXISTS
FOR (p:Parameter) ON (p.user_id, p.project_id);

CREATE INDEX idx_technology_tenant IF NOT EXISTS
FOR (t:Technology) ON (t.user_id, t.project_id);

CREATE INDEX idx_vulnerability_tenant IF NOT EXISTS
FOR (v:Vulnerability) ON (v.user_id, v.project_id);

CREATE INDEX idx_cve_tenant IF NOT EXISTS
FOR (c:CVE) ON (c.user_id, c.project_id);

CREATE INDEX idx_mitredata_tenant IF NOT EXISTS
FOR (m:MitreData) ON (m.user_id, m.project_id);

CREATE INDEX idx_capec_tenant IF NOT EXISTS
FOR (c:Capec) ON (c.user_id, c.project_id);

CREATE INDEX idx_dnsrecord_tenant IF NOT EXISTS
FOR (dns:DNSRecord) ON (dns.user_id, dns.project_id);

CREATE INDEX idx_header_tenant IF NOT EXISTS
FOR (h:Header) ON (h.user_id, h.project_id);

// =============================================================================
// ADDITIONAL INDEXES (attribute-based lookups within tenant data)
// =============================================================================

// Domain queries
CREATE INDEX domain_target IF NOT EXISTS
FOR (d:Domain) ON (d.target);

// Subdomain lookups
CREATE INDEX subdomain_name IF NOT EXISTS
FOR (s:Subdomain) ON (s.name);

// IP lookups
CREATE INDEX ip_address IF NOT EXISTS
FOR (i:IP) ON (i.address);

CREATE INDEX ip_cdn IF NOT EXISTS
FOR (i:IP) ON (i.is_cdn);

// BaseURL queries
CREATE INDEX baseurl_status IF NOT EXISTS
FOR (u:BaseURL) ON (u.status_code);

CREATE INDEX baseurl_live IF NOT EXISTS
FOR (u:BaseURL) ON (u.is_live);

// Technology lookups
CREATE INDEX tech_name IF NOT EXISTS
FOR (t:Technology) ON (t.name);

CREATE INDEX tech_name_version IF NOT EXISTS
FOR (t:Technology) ON (t.name, t.version);

CREATE INDEX tech_product IF NOT EXISTS
FOR (t:Technology) ON (t.product);

// Vulnerability queries (critical for attack chain analysis)
CREATE INDEX vuln_severity IF NOT EXISTS
FOR (v:Vulnerability) ON (v.severity);

CREATE INDEX vuln_category IF NOT EXISTS
FOR (v:Vulnerability) ON (v.category);

CREATE INDEX vuln_template IF NOT EXISTS
FOR (v:Vulnerability) ON (v.template_id);

CREATE INDEX vuln_dast IF NOT EXISTS
FOR (v:Vulnerability) ON (v.is_dast_finding);

// CVE queries
CREATE INDEX cve_severity IF NOT EXISTS
FOR (c:CVE) ON (c.severity);

CREATE INDEX cve_cvss IF NOT EXISTS
FOR (c:CVE) ON (c.cvss);

// Parameter queries (attack surface)
CREATE INDEX param_injectable IF NOT EXISTS
FOR (p:Parameter) ON (p.is_injectable);

```

---

## 📝 Notes for Implementation

1. **Deduplication**: Before creating nodes, check if they exist (MERGE vs CREATE)
2. **Timestamps**: Store as Neo4j datetime type for proper querying
3. **Arrays**: Neo4j supports array properties (tags, references, etc.)
4. **Large Text**: Keep descriptions under 10KB, store curl_command and request/response separately if needed
5. **Batch Import**: For large scans, use APOC procedures for batch imports

---

## 🗺️ JSON to Graph Mapping Reference

| JSON Path | Node Type | Key Properties |
|-----------|-----------|----------------|
| `metadata.*` | Domain | scan_timestamp, scan_type, target, modules_executed, anonymous_mode, bruteforce_mode |
| `whois.*` | Domain | registrar, creation_date, expiration_date, organization, country, city, state, address, registrant_postal_code, domain_name, referral_url, reseller |
| `subdomains[]` | Subdomain | name |
| `dns.subdomains.<host>.records.*` | DNSRecord | type, value |
| `dns.subdomains.<host>.ips.*` | IP | address, version |
| `port_scan.by_host.<host>.port_details[]` | Port | number, protocol |
| `port_scan.by_host.<host>.port_details[].service` | Service | name |
| `port_scan.ip_to_hostnames.*` | (relationship data) | IP ↔ Subdomain mapping |
| `http_probe.by_url.<url>.*` | BaseURL | url, status_code, content_*, server, cdn, *_hash, word_count, line_count, cname, asn |
| `http_probe.by_url.<url>.headers.*` | Header | name, value |
| `http_probe.by_url.<url>.technologies[]` | Technology | name, version |
| `http_probe.wappalyzer.all_technologies.*` | Technology | categories, confidence, versions_found |
| `vuln_scan.discovered_urls.dast_urls_with_params[]` | Endpoint | path, method, baseurl, has_parameters, source |
| `vuln_scan.discovered_urls.dast_urls_with_params[]` | Parameter | name, position, endpoint_path, baseurl, sample_value, is_injectable |
| `resource_enum.by_base_url.<url>.endpoints[]` | Endpoint | path, method, category, query_param_count, body_param_count, path_param_count, urls_found |
| `resource_enum.by_base_url.<url>.endpoints[].parameters.body[]` | Parameter | name, position='body', type, input_type, required |
| `resource_enum.forms[]` | Endpoint (update) | is_form, form_enctype, form_found_at_pages, form_input_names, form_count |
| `vuln_scan.by_target.<host>.findings[]` | Vulnerability | template_id, severity, matched_at, fuzzing_*, raw_request, raw_response, matched_ip, matcher_status, max_requests |
| `vuln_scan.by_target.<host>.findings[].raw.*` | Vulnerability | curl_command, extracted_results, extractor_name, authors (from raw.info.author) |
| `technology_cves.by_technology.<tech>.*` | Technology | product, version, cve_count, critical_cve_count, high_cve_count |
| `technology_cves.by_technology.<tech>.cves[]` | CVE | id, cvss, severity, description, published, source, url, references |
| `technology_cves.by_technology.<tech>.cves[].mitre_attack.cwe_hierarchy` | MitreData | cwe_id, cwe_name, cwe_description, abstraction, is_leaf |
| `technology_cves.by_technology.<tech>.cves[].mitre_attack.cwe_hierarchy.child` | MitreData | (nested CWE hierarchy) |
| `technology_cves.by_technology.<tech>.cves[].mitre_attack.cwe_hierarchy.*.related_capec[]` | Capec | id, name, description, likelihood, severity, prerequisites, execution_flow |

### Relationship Mapping

| JSON Context | Relationship | From → To |
|--------------|--------------|-----------|
| `dns.subdomains.<host>.ips.ipv4[]` | RESOLVES_TO | Subdomain → IP |
| `port_scan.by_host.<host>.port_details[]` | HAS_PORT | IP → Port |
| `port_scan.by_host.<host>.port_details[].service` | RUNS_SERVICE | Port → Service |
| `port_scan.ip_to_hostnames.<ip>[]` | RESOLVES_TO | Subdomain → IP |
| `http_probe.by_url.<url>` | SERVES_URL | Service → BaseURL |
| `http_probe.by_url.<url>.technologies[]` | USES_TECHNOLOGY | BaseURL → Technology |
| `vuln_scan.discovered_urls.dast_urls_with_params[]` | HAS_ENDPOINT | BaseURL → Endpoint |
| `vuln_scan.discovered_urls.dast_urls_with_params[]` | HAS_PARAMETER | Endpoint → Parameter |
| `vuln_scan.by_target.<host>.findings[]` | FOUND_AT | Vulnerability → Endpoint |
| `vuln_scan.by_target.<host>.findings[].raw.fuzzing_parameter` | AFFECTS_PARAMETER | Vulnerability → Parameter |
| `technology_cves.by_technology.<tech>.cves[]` | HAS_KNOWN_CVE | Technology → CVE |
| `technology_cves.by_technology.<tech>.cves[].mitre_attack.cwe_hierarchy` | HAS_MITRE_DATA | CVE → MitreData |
| `technology_cves.by_technology.<tech>.cves[].mitre_attack.cwe_hierarchy.child` | HAS_CHILD_CWE | MitreData → MitreData |
| `technology_cves.by_technology.<tech>.cves[].mitre_attack.cwe_hierarchy.*.related_capec[]` | RELATED_CAPEC | MitreData → Capec |

---

## 📊 Derived/Aggregation Data (No Dedicated Nodes)

The JSON contains several aggregation structures that don't need dedicated nodes since they can be computed from the graph:

| JSON Path | Description | Query Alternative |
|-----------|-------------|-------------------|
| `http_probe.by_host.<host>.*` | Per-host summary (urls, technologies, servers, status_codes) | `MATCH (s:Subdomain)-[:RESOLVES_TO]->(:IP)-[:HAS_PORT]->(:Port)-[:RUNS_SERVICE]->(svc)-[:SERVES_URL]->(u)...` |
| `http_probe.servers_found.*` | Server → URLs mapping | `MATCH (u:BaseURL) RETURN u.server, collect(u.url)` |
| `http_probe.technologies_found.*` | Technology → URLs mapping | `MATCH (u)-[:USES_TECHNOLOGY]->(t) RETURN t.name_version, collect(u.url)` |
| `http_probe.summary.by_status_code.*` | Count by status code | `MATCH (u:BaseURL) RETURN u.status_code, count(*)` |
| `vuln_scan.by_category.*` | Vulnerabilities grouped by category | `MATCH (v:Vulnerability) RETURN v.category, collect(v)` |
| `vuln_scan.by_target.<host>.severity_counts` | Severity counts per target | `MATCH (v:Vulnerability {target: $host}) RETURN v.severity, count(*)` |
| `vuln_scan.vulnerabilities.critical[]` | Critical vulns list | `MATCH (v:Vulnerability {severity: "critical"}) RETURN v` |
| `port_scan.all_ports[]` | All open ports list | `MATCH (p:Port) RETURN DISTINCT p.number` |

These are pre-computed for convenience in the JSON but the graph stores the source data.

---

## 🔮 Future Extensions (Not Implemented Yet)
- GVMScan, GVMVulnerability, DetectedProduct, Traceroute, OSFingerprint nodes (GVM integration - designed but not yet created by code; GVM vulns currently stored as Vulnerability nodes with source="gvm")
- `AttackChain` nodes linking vulnerabilities into exploitable paths
- `Credential` nodes for discovered credentials
- `GitHubSecret` nodes for leaked secrets
- `Screenshot` nodes linking to stored images
- `ScanSession` nodes for tracking multiple scan runs
