using System;
using Lumio.GameRuntime.Ecs;

namespace Lumio.Game.ServerGameplay;

/// <summary>
/// Runtime drain data consumed by gameplay/oracle code. Runtime owns both
/// collections; Game only keeps the C-1 frames separate from internal query results.
/// </summary>
public sealed class RuntimeDrainBatch
{
    internal RuntimeDrainBatch(WorldDrainResponse response)
    {
        Frames = response.Frames;
        Queries = response.Queries;
    }

    /// <summary>Encoded C-1 messages destined for the host transport.</summary>
    public System.Collections.Generic.IReadOnlyList<WorldMessage> Frames { get; }

    /// <summary>Owner-thread Runtime query/expiry results from <c>drain.queries</c>.</summary>
    public System.Collections.Generic.IReadOnlyList<WorldMessage> Queries { get; }
}

/// <summary>Thin consumer for the Runtime six-operation drain surface.</summary>
public static class RuntimeDrainConsumer
{
    /// <summary>Enqueues Runtime-owned expiry; destruction and tombstoning happen during owner Tick.</summary>
    public static void EnqueueExpiry(WorldManager manager, string requestId, NetEntityId netEntityId, string? connection = null)
    {
        if (manager is null) throw new ArgumentNullException(nameof(manager));
        manager.Enqueue(new ExpireEntityMessage(requestId, netEntityId, connection));
    }

    /// <summary>Enqueues a Runtime-owned binding resolution request.</summary>
    public static void EnqueueBindingResolution(WorldManager manager, string requestId, string roomId, NetEntityId netEntityId, ulong? connectionGeneration = null, string? connection = null)
    {
        if (manager is null) throw new ArgumentNullException(nameof(manager));
        manager.Enqueue(new ResolveBindingMessage(requestId, roomId, netEntityId, connectionGeneration, connection));
    }

    /// <summary>Enqueues a Runtime-owned declared attribute query.</summary>
    public static void EnqueueAttributeQuery(WorldManager manager, string requestId, string callerScope, string roomId, NetEntityId netEntityId, string attributeId, ulong? connectionGeneration = null, string? connection = null)
    {
        if (manager is null) throw new ArgumentNullException(nameof(manager));
        manager.Enqueue(new AttributeQueryMessage(requestId, callerScope, roomId, netEntityId, attributeId, connectionGeneration, connection));
    }

    /// <summary>Consumes one Runtime drain response without interpreting or storing authority.</summary>
    public static RuntimeDrainBatch Consume(WorldDrainResponse response)
    {
        if (response is null)
        {
            throw new ArgumentNullException(nameof(response));
        }

        return new RuntimeDrainBatch(response);
    }

    /// <summary>Drains Runtime C-1 frames and internal owner-thread query records together.</summary>
    public static RuntimeDrainBatch Drain(WorldManager manager)
    {
        if (manager is null)
        {
            throw new ArgumentNullException(nameof(manager));
        }

        return Consume(manager.DrainOutbox());
    }
}
