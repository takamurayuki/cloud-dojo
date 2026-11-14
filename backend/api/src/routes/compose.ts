import { FastifyInstance } from 'fastify';
import { assertComposeDefinitionSafe, composeService } from '../services/compose';
import { ComposeDefinitionRejectedError } from '../services/compose-guard';
import { addComposeUpTask, addComposeDownTask } from '../services/queue';

export async function composeRoutes(fastify: FastifyInstance) {
  // Compose Up - Start multi-container application (via queue)
  fastify.post('/api/compose/up', async (request, reply) => {
    try {
      const { composeYaml, projectName } = request.body as { 
        composeYaml: string; 
        projectName?: string;
      };

      if (!composeYaml) {
        return reply.code(400).send({ error: 'composeYaml is required' });
      }

      // ホストを操作できる設定（Docker ソケットの bind mount、privileged、host 名前空間、許可外の cap_add 等）を含む定義は、
      // キューに入れずに 400 で拒否する（直し回5 必須。Worker 側の composeUp でも同じ検査をしてから作成する）
      const project = projectName || 'cloud-dojo';
      let parsed: ReturnType<typeof composeService.parseComposeYAML> | null = null;
      try {
        parsed = composeService.parseComposeYAML(composeYaml);
      } catch {
        parsed = null; // この API のパーサで読めない定義は従来どおり Worker 側の失敗にする（YAML の検査は下で行う）
      }
      try {
        assertComposeDefinitionSafe(composeYaml, parsed ?? { version: '', services: {} }, project);
      } catch (error) {
        if (error instanceof ComposeDefinitionRejectedError) {
          return reply.code(400).send({ error: error.message, code: error.code, violations: error.violations });
        }
        throw error;
      }

      // Add to queue instead of executing directly
      const jobId = await addComposeUpTask({
        composeYaml,
        projectName: project,
      });

      return { 
        jobId,
        queueName: 'compose-up',
        status: 'queued',
        message: 'Compose up job added to queue'
      };
    } catch (error: any) {
      fastify.log.error(error);
      return reply.code(500).send({ error: error.message });
    }
  });

  // Compose Down - Stop and remove containers (via queue)
  fastify.post('/api/compose/down', async (request, reply) => {
    try {
      const { projectName, removeVolumes } = request.body as { 
        projectName?: string;
        removeVolumes?: boolean;
      };

      // Add to queue instead of executing directly
      const jobId = await addComposeDownTask({
        projectName: projectName || 'cloud-dojo',
        removeVolumes: removeVolumes || false,
      });

      return { 
        jobId,
        queueName: 'compose-down',
        status: 'queued',
        message: 'Compose down job added to queue'
      };
    } catch (error: any) {
      fastify.log.error(error);
      return reply.code(500).send({ error: error.message });
    }
  });

  // Compose Down with Volumes (via queue)
  fastify.post('/api/compose/down-volumes', async (request, reply) => {
    try {
      const { projectName } = request.body as { projectName?: string };
      
      const jobId = await addComposeDownTask({
        projectName: projectName || 'cloud-dojo',
        removeVolumes: true,
      });

      return { 
        jobId,
        queueName: 'compose-down',
        status: 'queued',
        message: 'Compose down with volumes job added to queue'
      };
    } catch (error: any) {
      fastify.log.error(error);
      return reply.code(500).send({ error: error.message });
    }
  });

  // Get Compose Status
  fastify.get('/api/compose/status', async (request, reply) => {
    try {
      const { projectName } = request.query as { projectName?: string };
      const status = await composeService.getComposeStatus(projectName);
      return { status };
    } catch (error: any) {
      fastify.log.error(error);
      return reply.code(500).send({ error: error.message });
    }
  });

  // Get Session Info
  fastify.get('/api/compose/session/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const session = composeService.getSession(id);
      
      if (!session) {
        return reply.code(404).send({ error: 'Session not found' });
      }
      
      return { session };
    } catch (error: any) {
      fastify.log.error(error);
      return reply.code(500).send({ error: error.message });
    }
  });
}
