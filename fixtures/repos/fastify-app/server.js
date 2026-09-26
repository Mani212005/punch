import Fastify from "fastify";
import axios from "axios";

const fastify = Fastify({ logger: true });

// Route: GET /items
fastify.get("/items", async (_request, _reply) => {
  // Call site: axios.get
  const res = await axios.get("https://api.example.com/items");
  return { items: res.data };
});

// Route: POST /items
fastify.post("/items", async (request, reply) => {
  const item = request.body;
  // Call site: axios.post
  const res = await axios.post("https://api.example.com/items", item);
  return reply.code(201).send(res.data);
});

// Route object syntax
fastify.route({
  method: "DELETE",
  url: "/items/:id",
  handler: async (request, _reply) => {
    return { deleted: request.params.id };
  },
});

export default fastify;
