# Myridius Implementation Agent

> AI-powered code implementation agent for Azure DevOps work items

## Overview

The **Myridius Implementation Agent** is a dedicated service that handles code implementation tasks for work items. It was separated from the estimation agent to provide better separation of concerns and independent scaling.

## Architecture

### Components

1. **Event Hub Consumer** (`src/worker/worker.ts`)
   - Listens for implementation events from Event Hub
   - Processes work items asynchronously
   - Handles retries and error recovery

2. **HTTP Webhook** (`functions/http/api-workitem-webhook/`)
   - Direct HTTP endpoint for implementation requests
   - Synchronous webhook trigger
   - Alternative to Event Hub for testing

3. **Libraries**
   - **Code RAG** (`src/lib/code-rag/`) - Code context retrieval
   - **Test Execution** (`src/lib/test-execution/`) - Test runner framework
   - **PR Management** (planned) - Pull request creation and management

### Workflow

```
┌─────────────────────┐
│ Estimation Agent    │
│ Decides to          │
│ Implement Code      │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│ Event Hub           │
│ (implementation-    │
│  events)            │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│ Implementation      │
│ Worker              │
│ - Retrieves context │
│ - Implements code   │
│ - Runs tests        │
│ - Creates PR        │
└─────────────────────┘
```

## Setup

### Prerequisites

- Node.js 18+ or 20+
- Azure Functions Core Tools v4
- Azure CLI
- Docker (for containerized deployment)
- Git

### Local Development

1. **Clone the repository**
   ```bash
   git clone https://dev.azure.com/your-org/your-project/_git/myridius-implementation-agent
   cd myridius-implementation-agent
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Configure local settings**
   ```bash
   cp local.settings.example.json local.settings.json
   # Edit local.settings.json with your configuration
   ```

4. **Build the project**
   ```bash
   npm run build
   ```

5. **Run locally**
   ```bash
   npm start
   ```

   The worker will start listening on Event Hub and the webhook will be available at:
   ```
   http://localhost:7072/api/workitem/webhook
   ```

### Testing

```bash
# Run unit tests
npm test

# Run tests in watch mode
npm run test:watch

# Run with coverage
npm run test:coverage
```

## Configuration

### Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `ANTHROPIC_API_KEY` | Anthropic Claude API key | Yes |
| `AZDO_ORG_URL` | Azure DevOps organization URL | Yes |
| `AZDO_PAT` | Azure DevOps Personal Access Token | Yes |
| `AZDO_PROJECT` | Azure DevOps project name | Yes |
| `EVENT_HUB_CONNECTION_STRING` | Event Hub connection string | Yes |
| `EVENT_HUB_NAME` | Event Hub name | Yes |
| `AZURE_OPENAI_ENDPOINT` | Azure OpenAI endpoint | Yes (for RAG) |
| `AZURE_OPENAI_API_KEY` | Azure OpenAI API key | Yes (for RAG) |
| `AZURE_SEARCH_ENDPOINT` | Azure Search endpoint | Yes (for RAG) |
| `AZURE_SEARCH_API_KEY` | Azure Search API key | Yes (for RAG) |
| `MAX_CONCURRENT_IMPLEMENTATIONS` | Max parallel implementations | No (default: 3) |
| `IMPLEMENTATION_TIMEOUT_MINUTES` | Timeout per implementation | No (default: 30) |

## Deployment

### Azure Container Apps (Recommended)

```bash
# Build and push Docker image
./scripts/deploy/build-aca-claude-worker-image.ps1 -Tag "1.0.0"

# Deploy to Azure Container Apps
./scripts/deploy/deploy-aca-claude-worker.ps1 `
  -ResourceGroup "myridius-rg" `
  -ContainerAppName "implementation-worker" `
  -ImageTag "1.0.0"
```

### Azure Functions

```bash
# Deploy using Azure Functions Core Tools
func azure functionapp publish <function-app-name>
```

## Development

### Project Structure

```
myridius-implementation-agent/
├── src/
│   ├── worker/
│   │   ├── worker.ts              # Event Hub consumer
│   │   ├── processWorkItem.ts     # Main implementation logic
│   │   ├── claude-runner.ts       # CLI executor
│   │   └── ...
│   └── lib/
│       ├── code-rag/              # Code retrieval
│       └── test-execution/        # Test framework
├── functions/
│   └── http/
│       └── api-workitem-webhook/  # HTTP trigger
├── scripts/
│   └── deploy/                    # Deployment scripts
├── tests/                         # Unit tests
├── Dockerfile                     # Container image
├── package.json
├── tsconfig.json
└── README.md
```

### Adding New Features

1. Create feature branch
2. Implement changes in `src/`
3. Add tests in `tests/`
4. Update documentation
5. Create pull request

### Code Style

This project uses:
- **TypeScript** for type safety
- **ESLint** for linting
- **Prettier** for formatting

```bash
# Lint code
npm run lint

# Format code
npm run format
```

## Monitoring

### Application Insights

The worker automatically logs to Application Insights if configured:

```json
{
  "APPINSIGHTS_INSTRUMENTATIONKEY": "your-key"
}
```

### Health Check

Health endpoint available at:
```
GET /api/health
```

Returns:
```json
{
  "status": "healthy",
  "timestamp": "2026-07-08T20:00:00Z",
  "version": "1.0.0"
}
```

## Troubleshooting

### Common Issues

**Issue**: Worker not processing events
- Check Event Hub connection string
- Verify consumer group exists
- Check Application Insights logs

**Issue**: Implementation failures
- Verify Anthropic API key is valid
- Check Azure DevOps PAT permissions
- Review implementation logs

**Issue**: Code context not retrieved
- Verify Azure Search index exists
- Check Azure OpenAI embeddings deployment
- Confirm index has documents

### Logs

View logs in:
- Local: Console output
- Azure: Application Insights or Container App logs
- Azure CLI: `az containerapp logs show`

## Contributing

1. Fork the repository
2. Create feature branch (`git checkout -b feature/amazing-feature`)
3. Commit changes (`git commit -m 'feat: add amazing feature'`)
4. Push to branch (`git push origin feature/amazing-feature`)
5. Create Pull Request

## Related Projects

- [myridius-estimation-agent](https://dev.azure.com/your-org/your-project/_git/myridius-estimation-agent) - Planning and estimation
- [myridius-cli-agent](https://www.npmjs.com/package/myridius-cli-agent) - CLI execution framework

## License

MIT

## Support

For issues and questions:
- Create an issue in Azure DevOps
- Contact the development team
- Check documentation in `/docs`

