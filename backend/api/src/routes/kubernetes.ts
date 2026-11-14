import { FastifyInstance, FastifyReply } from 'fastify';
import * as yaml from 'js-yaml';
import { k8sService } from '../services/kubernetes';
import { addK8sDeployTask } from '../services/queue';
import { K8sInputError, parseTailQuery, validateManifestDocs, validateNamespace } from '../services/k8s-args';

/**
 * 入力が Kubernetes の名前として妥当でなければ 400 `K8S_INVALID_INPUT`（kubectl は起動しない）。それ以外は従来どおり 500。
 * 直し回4補足1：namespace・name・kind 等をシェルに渡さないよう、services/kubernetes.ts は execFile で引数を分けて実行し、
 * 入力は services/k8s-args.ts の規則で検証する。
 */
function sendError(reply: FastifyReply, error: unknown) {
  if (error instanceof K8sInputError) {
    return reply.code(400).send({ error: error.code, field: error.field, message: error.message });
  }
  return reply.code(500).send({ error: error instanceof Error ? error.message : String(error) });
}

export async function kubernetesRoutes(fastify: FastifyInstance) {
  // Check if kubectl is available
  fastify.get('/api/k8s/check', async (request, reply) => {
    try {
      const isAvailable = await k8sService.checkKubectl();
      const context = isAvailable ? await k8sService.getCurrentContext() : null;
      
      return { 
        available: isAvailable,
        context,
      };
    } catch (error: any) {
      fastify.log.error(error);
      return sendError(reply, error);
    }
  });

  // Get namespaces
  fastify.get('/api/k8s/namespaces', async (request, reply) => {
    try {
      const namespaces = await k8sService.getNamespaces();
      return { namespaces };
    } catch (error: any) {
      fastify.log.error(error);
      return sendError(reply, error);
    }
  });

  // Apply manifest (via queue)
  fastify.post('/api/k8s/apply', async (request, reply) => {
    try {
      const { manifest, namespace } = request.body as { 
        manifest: string; 
        namespace?: string;
      };

      if (!manifest) {
        return reply.code(400).send({ error: 'manifest is required' });
      }

      // キューに入れる前に検証する（妥当でなければ 400 で、ジョブを作らない。Worker 側の applyManifest でも同じ検証をする）
      validateNamespace(namespace || 'default');
      let docs: unknown[];
      try {
        docs = yaml.loadAll(manifest) as unknown[];
      } catch {
        return reply.code(400).send({ error: 'manifest is not valid YAML' });
      }
      validateManifestDocs(docs as Parameters<typeof validateManifestDocs>[0]);

      // Add to queue
      const jobId = await addK8sDeployTask({
        manifest,
        namespace: namespace || 'default',
      });

      return { 
        jobId,
        queueName: 'k8s-deploy',
        status: 'queued',
        message: 'K8s deployment job added to queue'
      };
    } catch (error: any) {
      fastify.log.error(error);
      return sendError(reply, error);
    }
  });

  // Delete resource
  fastify.delete('/api/k8s/resource', async (request, reply) => {
    try {
      const { kind, name, namespace } = request.body as { 
        kind: string;
        name: string;
        namespace?: string;
      };

      if (!kind || !name) {
        return reply.code(400).send({ error: 'kind and name are required' });
      }

      await k8sService.deleteResource(kind, name, namespace || 'default');
      return { success: true };
    } catch (error: any) {
      fastify.log.error(error);
      return sendError(reply, error);
    }
  });

  // Get pods
  fastify.get('/api/k8s/pods', async (request, reply) => {
    try {
      const { namespace } = request.query as { namespace?: string };
      const pods = await k8sService.getPods(namespace || 'default');
      return { pods };
    } catch (error: any) {
      fastify.log.error(error);
      return sendError(reply, error);
    }
  });

  // Get deployments
  fastify.get('/api/k8s/deployments', async (request, reply) => {
    try {
      const { namespace } = request.query as { namespace?: string };
      const deployments = await k8sService.getDeployments(namespace || 'default');
      return { deployments };
    } catch (error: any) {
      fastify.log.error(error);
      return sendError(reply, error);
    }
  });

  // Get services
  fastify.get('/api/k8s/services', async (request, reply) => {
    try {
      const { namespace } = request.query as { namespace?: string };
      const services = await k8sService.getServices(namespace || 'default');
      return { services };
    } catch (error: any) {
      fastify.log.error(error);
      return sendError(reply, error);
    }
  });

  // Get pod logs
  fastify.get('/api/k8s/pods/:name/logs', async (request, reply) => {
    try {
      const { name } = request.params as { name: string };
      const { namespace, tail } = request.query as { namespace?: string; tail?: string };
      
      const logs = await k8sService.getPodLogs(
        name, 
        namespace || 'default',
        parseTailQuery(tail)
      );
      
      return { logs };
    } catch (error: any) {
      fastify.log.error(error);
      return sendError(reply, error);
    }
  });

  // Get session info
  fastify.get('/api/k8s/session/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const session = k8sService.getSession(id);
      
      if (!session) {
        return reply.code(404).send({ error: 'Session not found' });
      }
      
      return { session };
    } catch (error: any) {
      fastify.log.error(error);
      return sendError(reply, error);
    }
  });
}
