using System;
using System.Text;
using Lumio.Game.ServerGameplay;
using Lumio.GameRuntime.Ecs;
using Lumio.GameRuntime.Samples.Username.Components.Chat;
using Xunit;

namespace Lumio.Game.ServerGameplay.Tests;

public sealed class RuntimeCodecBoundaryTests
{
    [Fact]
    public void RuntimeCodecRoundTripsTypedInputCommand()
    {
        NetEntityId sender = new(ChatWorldHarness.InstanceId, 1UL);
        InputCommandMessage command = new(
            ChatMapping.InputMappingId,
            sender,
            ChatPayload("hello"),
            "C1");

        byte[] encoded = WireCodec.EncodeInput(command);
        InputCommandMessage decoded = WireCodec.DecodeInput(encoded, sender);

        Assert.Equal(sender, decoded.Sender);
        Assert.Equal(ChatMapping.InputMappingId, decoded.MappingId);
        Assert.True(WireCodec.TryReadUtf8Payload(decoded.Payload.Span, out string text));
        Assert.Equal("hello", text);
    }

    [Fact]
    public void GameAdmitEnvelopeDelegatesValidationToRuntimeCodec()
    {
        using WorldManager manager = ChatWorldHarness.Boot();
        NetEntityId sender = ChatWorldHarness.Net(manager, 0);
        byte[] envelope = WireCodec.EncodeInput(new InputCommandMessage(
            ChatMapping.InputMappingId,
            sender,
            ChatPayload("hello"),
            "C1"));

        ChatOperationResult admitted = ChatSetMessageSystem.AdmitEnvelope(
            manager, "room-01", sender, "C1", 1UL, envelope);

        Assert.Equal(ChatOperationKind.Admitted, admitted.Kind);
        manager.Tick();
        Assert.Equal("hello", ChatSetMessageSystem.TryGetComponent(manager, sender, out ChatComponent? component)
            ? component.LastMessageText
            : null);
    }

    [Fact]
    public void RuntimeCodecHashRejectionMapsToGameErrorWithoutEnqueue()
    {
        using WorldManager manager = ChatWorldHarness.Boot();
        NetEntityId sender = ChatWorldHarness.Net(manager, 0);
        string envelope = Encoding.UTF8.GetString(WireCodec.EncodeInput(new InputCommandMessage(
            ChatMapping.InputMappingId,
            sender,
            ChatPayload("hello"),
            "C1")));
        const string marker = "payloadSha256\":\"";
        int hashStart = envelope.IndexOf(marker, StringComparison.Ordinal) + marker.Length;
        string tampered = envelope[..hashStart] + new string('0', 64) + envelope[(hashStart + 64)..];

        ChatOperationResult rejected = ChatSetMessageSystem.AdmitEnvelope(
            manager, "room-01", sender, "C1", 1UL, Encoding.UTF8.GetBytes(tampered));

        Assert.Equal(ChatOperationKind.Rejected, rejected.Kind);
        Assert.Equal(ChatErrorCodes.BadPayloadHash, rejected.ErrorCode);
        manager.Tick();
        Assert.True(ChatSetMessageSystem.TryGetComponent(manager, sender, out ChatComponent? component));
        Assert.Equal(string.Empty, component.LastMessageText);
    }

    [Fact]
    public void RuntimeCodecUnknownMappingMapsToGameError()
    {
        using WorldManager manager = ChatWorldHarness.Boot();
        NetEntityId sender = ChatWorldHarness.Net(manager, 0);
        byte[] envelope = WireCodec.EncodeInput(new InputCommandMessage(
            "chat.unknown",
            sender,
            ChatPayload("hello"),
            "C1"));

        ChatOperationResult rejected = ChatSetMessageSystem.AdmitEnvelope(
            manager, "room-01", sender, "C1", 1UL, envelope);

        Assert.Equal(ChatOperationKind.Rejected, rejected.Kind);
        Assert.Equal(ChatErrorCodes.UnknownCommandType, rejected.ErrorCode);
    }

    [Fact]
    public void RuntimeCodecWrongMessageTypeMapsToBadEnvelope()
    {
        using WorldManager manager = ChatWorldHarness.Boot();
        NetEntityId sender = ChatWorldHarness.Net(manager, 0);
        string encoded = Encoding.UTF8.GetString(WireCodec.EncodeInput(new InputCommandMessage(
            ChatMapping.InputMappingId,
            sender,
            ChatPayload("hello"),
            "C1")));
        byte[] wrongType = Encoding.UTF8.GetBytes(encoded.Replace("InputCommand", "Delta", StringComparison.Ordinal));

        ChatOperationResult rejected = ChatSetMessageSystem.AdmitEnvelope(
            manager, "room-01", sender, "C1", 1UL, wrongType);

        Assert.Equal(ChatOperationKind.Rejected, rejected.Kind);
        Assert.Equal(ChatErrorCodes.BadEnvelope, rejected.ErrorCode);
    }

    [Fact]
    public void RuntimeCodecRejectsMalformedInputEnvelope()
    {
        Assert.Throws<FormatException>(() => WireCodec.DecodeInput(
            Encoding.UTF8.GetBytes("{\"messageType\":\"InputCommand\",\"commands\":null}")));
    }

    private static byte[] ChatPayload(string text)
    {
        byte[] utf8 = Encoding.UTF8.GetBytes(text);
        byte[] payload = new byte[4 + utf8.Length];
        System.Buffers.Binary.BinaryPrimitives.WriteUInt32LittleEndian(payload, (uint)utf8.Length);
        Buffer.BlockCopy(utf8, 0, payload, 4, utf8.Length);
        return payload;
    }
}
