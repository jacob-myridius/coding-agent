# Phase 2: New Project Setup Guide

## Overview
This directory contains all files exported from `myridius-estimation-agent` that need to be moved to the new `myridius-implementation-agent` project.

## Step-by-Step Setup Instructions

### 1. Create New Azure DevOps Repository

```bash
# In Azure DevOps
1. Go to your Azure DevOps organization
2. Navigate to Repos > Files
3. Click "New repository"
4. Name: myridius-implementation-agent
5. Add README: No (we'll create our own)
6. Add .gitignore: Node
7. Create Repository
```

### 2. Clone the New Repository

```powershell
# Navigate to your workspace
cd C:\Users\User

# Clone the new repository
git clone https://dev.azure.com/your-org/your-project/_git/myridius-implementation-agent

cd myridius-implementation-agent
```

### 3. Initialize Project Structure

```powershell
# Create directory structure
New-Item -ItemType Directory -Path "src/worker" -Force
New-Item -ItemType Directory -Path "src/lib" -Force
New-Item -ItemType Directory -Path "functions/http/api-workitem-webhook" -Force
New-Item -ItemType Directory -Path "prompts" -Force
New-Item -ItemType Directory -Path "scripts/deploy" -Force
New-Item -ItemType Directory -Path "tests/worker" -Force
```

### 4. Copy Files from Export Directory

```powershell
$exportDir = "C:\Users\User\myridius-estimation-agent\migration-export-20260708-201921"
$projectDir = "C:\Users\User\myridius-implementation-agent"

# Copy worker files
Copy-Item -Path "$exportDir\worker\*" -Destination "$projectDir\src\worker" -Recurse -Force

# Copy libraries
Copy-Item -Path "$exportDir\src\lib\test-execution" -Destination "$projectDir\src\lib\" -Recurse -Force
Copy-Item -Path "$exportDir\src\lib\code-rag" -Destination "$projectDir\src\lib\" -Recurse -Force

# Note: PR library will be copied separately if needed

# Copy CLI package
Copy-Item -Path "$exportDir\myridius-cli-agent-0.9.2.tgz" -Destination "$projectDir\" -Force

# Copy deployment scripts (will be created in next step)
```

### 5. Create package.json

Copy the `package.json` file provided in this directory to the root of your new project.

### 6. Create tsconfig.json

Copy the `tsconfig.json` file provided in this directory to the root of your new project.

### 7. Create host.json (Azure Functions Config)

Copy the `host.json` file provided in this directory to the root of your new project.

### 8. Create Dockerfile

Copy the `Dockerfile` file provided in this directory to the root of your new project.

### 9. Create .gitignore

Azure DevOps should have created this, but verify it includes:
```
node_modules/
dist/
.env
*.log
local.settings.json
.funcignore
```

### 10. Install Dependencies

```powershell
cd C:\Users\User\myridius-implementation-agent

# Install npm packages
npm install

# Install CLI agent
npm install ./myridius-cli-agent-0.9.2.tgz
```

### 11. Convert JavaScript Files to TypeScript

The worker files are currently in JavaScript. You'll need to convert them:

```powershell
# Files to convert:
# - src/worker/worker.js → src/worker/worker.ts
# - src/worker/*.js → src/worker/*.ts
```

See the conversion guide in `JAVASCRIPT_TO_TYPESCRIPT_CONVERSION.md`.

### 12. Create Implementation Webhook Function

Create `functions/http/api-workitem-webhook/index.ts`:
```typescript
import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { processImplementationWorkItem } from "../../../src/worker/processWorkItem";

export async function workitemWebhook(
    request: HttpRequest,
    context: InvocationContext
): Promise<HttpResponseInit> {
    context.log("Implementation webhook triggered");

    try {
        const body = await request.json() as any;
        
        // Process the work item
        await processImplementationWorkItem(body, context);

        return {
            status: 202,
            jsonBody: { message: "Implementation queued successfully" }
        };
    } catch (error) {
        context.error("Error in implementation webhook:", error);
        return {
            status: 500,
            jsonBody: { error: "Internal server error" }
        };
    }
}

app.http("api-workitem-webhook", {
    methods: ["POST"],
    authLevel: "function",
    handler: workitemWebhook,
});
```

Create `functions/http/api-workitem-webhook/function.json`:
```json
{
  "bindings": [
    {
      "authLevel": "function",
      "type": "httpTrigger",
      "direction": "in",
      "name": "req",
      "methods": ["post"],
      "route": "workitem/webhook"
    },
    {
      "type": "http",
      "direction": "out",
      "name": "res"
    }
  ]
}
```

### 13. Create Configuration Files

Create `local.settings.example.json`:
```json
{
  "IsEncrypted": false,
  "Values": {
    "AzureWebJobsStorage": "",
    "FUNCTIONS_WORKER_RUNTIME": "node",
    "ANTHROPIC_API_KEY": "",
    "AZDO_ORG_URL": "",
    "AZDO_PAT": "",
    "EVENT_HUB_CONNECTION_STRING": "",
    "EVENT_HUB_NAME": "implementation-events"
  }
}
```

### 14. Update Documentation

Create `README.md`:
```markdown
# Myridius Implementation Agent

This agent handles code implementation for work items.

## Architecture

- **Worker**: Event Hub consumer that processes implementation requests
- **Webhook**: HTTP endpoint for direct implementation requests
- **Libraries**: Shared code for RAG retrieval, test execution, and PR creation

## Setup

1. Install dependencies: `npm install`
2. Configure local.settings.json
3. Build: `npm run build`
4. Run locally: `npm start`

## Deployment

See deployment scripts in `scripts/deploy/`
```

### 15. Build and Test

```powershell
# Build the project
npm run build

# Run tests (if any)
npm test

# Start locally
npm start
```

### 16. Commit Initial Structure

```powershell
git add .
git commit -m "feat: initial implementation agent structure

- Worker files from estimation agent
- RAG retrieval and code context
- Test execution framework
- Implementation webhook endpoint
- Docker container configuration"

git push origin main
```

## Next Steps (Phase 3)

1. Create Azure resources (Function App, Event Hub, etc.)
2. Deploy to Azure
3. Configure Event Hub routing from estimation agent
4. Test end-to-end workflow
5. Update estimation agent to remove old files (Phase 4)

## Files in This Export

### Core Worker Files
- `worker/` - All worker implementation files (currently JavaScript)

### Libraries
- `src/lib/test-execution/` - Test execution framework
- `src/lib/code-rag/` - Code RAG retrieval
- ~~`src/lib/pr/`~~ - PR creation (not included in this export)

### Dependencies
- `myridius-cli-agent-0.9.2.tgz` - CLI agent package

### Scripts
- Deployment scripts will be created in setup process

## Conversion Tasks

### High Priority
1. ☐ Convert worker.js to TypeScript
2. ☐ Convert all worker/*.js files to TypeScript
3. ☐ Create processWorkItem.ts handler
4. ☐ Create implementation webhook
5. ☐ Update import statements

### Medium Priority
6. ☐ Add type definitions for all interfaces
7. ☐ Create error handling middleware
8. ☐ Add logging infrastructure
9. ☐ Create unit tests

### Low Priority
10. ☐ Add JSDoc comments
11. ☐ Create integration tests
12. ☐ Performance optimization

## Estimated Time

- Setup (Steps 1-10): 2 hours
- Conversion (Step 11): 4-6 hours
- Testing (Steps 14-15): 2 hours
- **Total**: ~8-10 hours

## Support

For questions or issues, refer to:
- Original refactoring plan: `REFACTOR_CODE_WORKER_SEPARATION_PLAN.md` in estimation agent
- Phase 1 status: `REFACTOR_PHASE1_FINAL_STATUS.md` in estimation agent

